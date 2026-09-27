import { z } from 'zod';
import { AllocationSnapshotSchema } from './bandit.js';
import type { AllocationSnapshot } from './bandit.js';
import { ExperimentDefinitionSchema } from './contracts.js';
import type { ExperimentDefinition, ExperimentEvent } from './contracts.js';

const key = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const count = z.number().int().nonnegative().safe();

export const RewardAggregateSchema = z.object({
  projectKey: key,
  experimentKey: key,
  definitionRevision: z.number().int().min(1),
  batchSequence: z.number().int().min(1).safe(),
  batchId: key,
  observedThrough: z.string().datetime({ offset: true }),
  variants: z.array(z.object({
    variantKey: key,
    matureExposures: count,
    rewards: count,
  }).strict().readonly()).min(2).max(8),
}).strict().superRefine((aggregate, context) => {
  const keys = aggregate.variants.map(variant => variant.variantKey);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: 'Variant keys must be unique' });
  }
  aggregate.variants.forEach((variant, index) => {
    if (variant.rewards > variant.matureExposures) {
      context.addIssue({ code: 'custom', path: ['variants', index, 'rewards'], message: 'Rewards cannot exceed mature exposures' });
    }
  });
}).readonly();

export type RewardAggregate = z.infer<typeof RewardAggregateSchema>;

export interface RewardSnapshotStore {
  read(projectKey: string, experimentKey: string, definitionRevision: number): Promise<AllocationSnapshot | null>;
  /** Compare-and-set on batch sequence so concurrent workers cannot publish out of order. */
  compareAndSet(input: Readonly<{
    projectKey: string;
    experimentKey: string;
    definitionRevision: number;
    expectedBatchSequence: number | null;
    snapshot: AllocationSnapshot;
  }>): Promise<boolean>;
}

type Exposure = Readonly<{ variantKey: string; subjectHash: string; occurredAtMs: number }>;
type Reward = Readonly<{ variantKey: string; subjectHash: string; occurredAtMs: number }>;

/** Count distinct assignments only after their configured reward window is mature. */
export function aggregateMaturedRewards(
  projectKey: string,
  definition: ExperimentDefinition,
  events: readonly ExperimentEvent[],
  observedThrough: string,
  batchSequence: number,
  batchId: string,
): RewardAggregate {
  if (definition.reward.mode !== 'occurrence') throw new RewardBatchError('unsupported_reward_mode');
  const cutoff = Date.parse(observedThrough);
  if (Number.isNaN(cutoff)) throw new RewardBatchError('aggregate_mismatch');
  const exposures = new Map<string, Exposure>();
  const rewards = new Map<string, Reward[]>();
  const seenEventIds = new Set<string>();

  for (const event of events) {
    if (seenEventIds.has(event.eventId)) continue;
    seenEventIds.add(event.eventId);
    if (event.projectKey !== projectKey || event.experimentKey !== definition.key || event.definitionRevision !== definition.revision || event.assignmentId === null) continue;
    const eventTime = Date.parse(event.occurredAt);
    if (Number.isNaN(eventTime) || eventTime > cutoff) continue;
    if (event.eventKind === 'exposure' && event.variantKey !== null && event.subjectHash !== null) {
      const prior = exposures.get(event.assignmentId);
      if (prior === undefined || eventTime < prior.occurredAtMs) {
        exposures.set(event.assignmentId, { variantKey: event.variantKey, subjectHash: event.subjectHash, occurredAtMs: eventTime });
      }
    }
    if (event.eventKind === 'signal' && event.signalKey === definition.reward.key && event.signalKind === definition.reward.kind && event.variantKey !== null && event.subjectHash !== null) {
      const matchingRewards = rewards.get(event.assignmentId) ?? [];
      matchingRewards.push({ variantKey: event.variantKey, subjectHash: event.subjectHash, occurredAtMs: eventTime });
      rewards.set(event.assignmentId, matchingRewards);
    }
  }

  const countsByVariant = new Map(definition.variants.map(variant => [variant.key, { matureExposures: 0, rewards: 0 }]));
  const windowMs = definition.reward.attributionWindowSeconds * 1000;
  for (const [assignmentId, exposure] of exposures) {
    const counts = countsByVariant.get(exposure.variantKey);
    if (counts === undefined) continue;
    const closesAt = exposure.occurredAtMs + windowMs;
    if (closesAt > cutoff) continue;
    counts.matureExposures += 1;
    const matchingRewards = rewards.get(assignmentId) ?? [];
    const succeeded = matchingRewards.some(reward =>
      reward.variantKey === exposure.variantKey
      && reward.subjectHash === exposure.subjectHash
      && reward.occurredAtMs >= exposure.occurredAtMs
      && reward.occurredAtMs <= closesAt,
    );
    if (succeeded) counts.rewards += 1;
  }

  return RewardAggregateSchema.parse({
    projectKey,
    experimentKey: definition.key,
    definitionRevision: definition.revision,
    batchSequence,
    batchId,
    observedThrough,
    variants: definition.variants.map(variant => ({ variantKey: variant.key, ...countsByVariant.get(variant.key) })),
  });
}

export class RewardBatchError extends Error {
  override readonly name = 'RewardBatchError';
  constructor(readonly reason: 'invalid_definition' | 'aggregate_mismatch' | 'incomplete_variants' | 'stale_batch' | 'batch_conflict' | 'aggregate_regression' | 'unsupported_reward_mode') {
    super(reason);
  }
}

/** Applies a full warehouse aggregate as a monotonic, retry-safe posterior snapshot. */
export class BatchRewardUpdater {
  readonly #store: RewardSnapshotStore;

  constructor(store: RewardSnapshotStore) {
    this.#store = store;
  }

  async apply(projectKey: string, definitionInput: unknown, aggregateInput: unknown): Promise<AllocationSnapshot> {
    const definition = ExperimentDefinitionSchema.safeParse(definitionInput);
    if (!definition.success) throw new RewardBatchError('invalid_definition');
    const aggregate = RewardAggregateSchema.safeParse(aggregateInput);
    if (!aggregate.success) throw new RewardBatchError('aggregate_mismatch');
    if (aggregate.data.projectKey !== projectKey) throw new RewardBatchError('aggregate_mismatch');
    const previous = await this.#store.read(projectKey, definition.data.key, definition.data.revision);
    const snapshot = applyRewardAggregate(projectKey, previous, definition.data, aggregate.data);
    const expectedBatchSequence = previous?.batchSequence ?? null;
    if (snapshot.batchSequence === expectedBatchSequence) return snapshot;
    const committed = await this.#store.compareAndSet({
      projectKey,
      experimentKey: definition.data.key,
      definitionRevision: definition.data.revision,
      expectedBatchSequence,
      snapshot,
    });
    if (!committed) throw new RewardBatchError('batch_conflict');
    return snapshot;
  }
}

/** Replace posterior counts from a full cumulative aggregate, making batch retries idempotent. */
export function applyRewardAggregate(
  projectKey: string,
  previousInput: unknown,
  definitionInput: unknown,
  aggregateInput: unknown,
): AllocationSnapshot {
  const definition = ExperimentDefinitionSchema.safeParse(definitionInput);
  const aggregate = RewardAggregateSchema.safeParse(aggregateInput);
  const previous = previousInput === null ? null : AllocationSnapshotSchema.safeParse(previousInput);
  if (!definition.success) throw new RewardBatchError('invalid_definition');
  if (!aggregate.success || (previousInput !== null && previous?.success !== true)) throw new RewardBatchError('aggregate_mismatch');
  if (aggregate.data.projectKey !== projectKey || aggregate.data.experimentKey !== definition.data.key || aggregate.data.definitionRevision !== definition.data.revision) {
    throw new RewardBatchError('aggregate_mismatch');
  }
  if (previous?.success === true && (previous.data.projectKey !== projectKey || previous.data.experimentKey !== definition.data.key || previous.data.definitionRevision !== definition.data.revision)) {
    throw new RewardBatchError('aggregate_mismatch');
  }
  if (previous?.success === true) {
    if (aggregate.data.batchSequence < previous.data.batchSequence || Date.parse(aggregate.data.observedThrough) < Date.parse(previous.data.observedThrough)) {
      throw new RewardBatchError('stale_batch');
    }
    if (aggregate.data.batchSequence === previous.data.batchSequence) {
      const priorCounts = new Map(previous.data.variants.map(variant => [variant.variantKey, `${variant.successes}:${variant.failures}`]));
      const incomingCounts = new Map(aggregate.data.variants.map(variant => [variant.variantKey, `${variant.rewards}:${variant.matureExposures - variant.rewards}`]));
      const sameCounts = priorCounts.size === incomingCounts.size && [...priorCounts].every(([variantKey, counts]) => incomingCounts.get(variantKey) === counts);
      if (aggregate.data.batchId !== previous.data.batchId || aggregate.data.observedThrough !== previous.data.observedThrough || !sameCounts) {
        throw new RewardBatchError('batch_conflict');
      }
      return previous.data;
    }
    if (aggregate.data.batchId === previous.data.batchId) throw new RewardBatchError('batch_conflict');
    const previousByVariant = new Map(previous.data.variants.map(variant => [variant.variantKey, variant]));
    for (const variant of aggregate.data.variants) {
      const old = previousByVariant.get(variant.variantKey);
      if (old !== undefined && (variant.matureExposures < old.successes + old.failures || variant.rewards < old.successes)) {
        throw new RewardBatchError('aggregate_regression');
      }
    }
  }

  const expected = new Set(definition.data.variants.map(variant => variant.key));
  const received = new Set(aggregate.data.variants.map(variant => variant.variantKey));
  if (expected.size !== received.size || [...expected].some(variantKey => !received.has(variantKey))) {
    throw new RewardBatchError('incomplete_variants');
  }
  return AllocationSnapshotSchema.parse({
    projectKey,
    experimentKey: definition.data.key,
    definitionRevision: definition.data.revision,
    batchSequence: aggregate.data.batchSequence,
    batchId: aggregate.data.batchId,
    observedThrough: aggregate.data.observedThrough,
    variants: definition.data.variants.map(definedVariant => {
      const variant = aggregate.data.variants.find(row => row.variantKey === definedVariant.key);
      if (variant === undefined) throw new RewardBatchError('incomplete_variants');
      return {
        variantKey: variant.variantKey,
        successes: variant.rewards,
        failures: variant.matureExposures - variant.rewards,
      };
    }),
  });
}
