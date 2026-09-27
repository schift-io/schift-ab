import { z } from 'zod';
import { AssignmentSchema } from './contracts.js';
import type { AllocationEngine, Assignment, ExperimentDefinition } from './contracts.js';

const key = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const counts = z.number().int().nonnegative().safe();

export const AllocationSnapshotSchema = z.object({
  projectKey: key,
  experimentKey: key,
  definitionRevision: z.number().int().min(1),
  batchSequence: z.number().int().nonnegative().safe(),
  batchId: key,
  observedThrough: z.string().datetime({ offset: true }),
  variants: z.array(z.object({
    variantKey: key,
    successes: counts,
    failures: counts,
  }).strict().readonly()).min(2).max(8),
}).strict().superRefine((snapshot, context) => {
  const keys = snapshot.variants.map(variant => variant.variantKey);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: 'Variant keys must be unique' });
  }
}).readonly();

export type AllocationSnapshot = z.infer<typeof AllocationSnapshotSchema>;
export type UniformRandom = () => number;

/** Equal Beta(1,1) priors let a new experiment start before its first reward batch. */
export function createPriorSnapshot(projectKey: string, experiment: ExperimentDefinition, observedThrough: Date): AllocationSnapshot {
  return AllocationSnapshotSchema.parse({
    projectKey,
    experimentKey: experiment.key,
    definitionRevision: experiment.revision,
    batchSequence: 0,
    batchId: `bootstrap_${experiment.revision}`,
    observedThrough: observedThrough.toISOString(),
    variants: experiment.variants.map(variant => ({ variantKey: variant.key, successes: 0, failures: 0 })),
  });
}

export interface AllocationRepository {
  readSnapshot(projectKey: string, experimentKey: string, definitionRevision: number): Promise<AllocationSnapshot | null>;
  findAssignment(projectKey: string, experimentKey: string, definitionRevision: number, subjectHash: string): Promise<Assignment | null>;
  /** Must atomically preserve the first assignment when concurrent requests race. */
  putAssignmentIfAbsent(projectKey: string, assignment: Assignment): Promise<Assignment>;
}

export class AllocationError extends Error {
  override readonly name = 'AllocationError';
  constructor(readonly reason: 'snapshot_mismatch' | 'snapshot_stale' | 'assignment_mismatch' | 'invalid_random_source' | 'sampling_failed' | 'unsupported_reward_mode') {
    super(reason);
  }
}

/** Owns request-time assignment; persistent snapshots and sticky buckets belong to the repository. */
export type AdaptiveBanditOptions = Readonly<{
  uniform?: UniformRandom;
  clock?: () => number;
  maxSnapshotAgeMs?: number;
}>;

export class AdaptiveBandit implements AllocationEngine {
  readonly #repository: AllocationRepository;
  readonly #uniform: UniformRandom;
  readonly #clock: () => number;
  readonly #maxSnapshotAgeMs: number;

  constructor(repository: AllocationRepository, options: AdaptiveBanditOptions = {}) {
    this.#repository = repository;
    this.#uniform = options.uniform ?? secureUniform;
    this.#clock = options.clock ?? Date.now;
    this.#maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? 6 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.#maxSnapshotAgeMs) || this.#maxSnapshotAgeMs < 1) {
      throw new RangeError('maxSnapshotAgeMs must be a positive safe integer');
    }
  }

  async assign(input: Readonly<{ projectKey: string; experiment: ExperimentDefinition; subjectHash: string }>): Promise<Assignment> {
    if (input.experiment.reward.mode !== 'occurrence') throw new AllocationError('unsupported_reward_mode');
    const existing = await this.#repository.findAssignment(input.projectKey, input.experiment.key, input.experiment.revision, input.subjectHash);
    if (existing !== null) {
      if (existing.projectKey !== input.projectKey || existing.subjectHash !== input.subjectHash || existing.experimentKey !== input.experiment.key || existing.definitionRevision !== input.experiment.revision || !input.experiment.variants.some(variant => variant.key === existing.variantKey)) {
        throw new AllocationError('assignment_mismatch');
      }
      return existing;
    }

    const rawSnapshot = await this.#repository.readSnapshot(input.projectKey, input.experiment.key, input.experiment.revision);
    const sourceSnapshot = rawSnapshot ?? createPriorSnapshot(input.projectKey, input.experiment, new Date(this.#clock()));
    const parsedSnapshot = AllocationSnapshotSchema.safeParse(sourceSnapshot);
    if (!parsedSnapshot.success || parsedSnapshot.data.projectKey !== input.projectKey || parsedSnapshot.data.experimentKey !== input.experiment.key || parsedSnapshot.data.definitionRevision !== input.experiment.revision) {
      throw new AllocationError('snapshot_mismatch');
    }
    const ageMs = this.#clock() - Date.parse(parsedSnapshot.data.observedThrough);
    if (ageMs < 0 || ageMs > this.#maxSnapshotAgeMs) throw new AllocationError('snapshot_stale');
    const expectedVariants = new Set(input.experiment.variants.map(variant => variant.key));
    const snapshotVariants = new Set(parsedSnapshot.data.variants.map(variant => variant.variantKey));
    if (expectedVariants.size !== snapshotVariants.size || [...expectedVariants].some(variantKey => !snapshotVariants.has(variantKey))) {
      throw new AllocationError('snapshot_mismatch');
    }
    const variantKey = chooseVariant(parsedSnapshot.data, this.#uniform);
    const assignment = AssignmentSchema.parse({
      projectKey: input.projectKey,
      assignmentId: globalThis.crypto.randomUUID(),
      experimentKey: input.experiment.key,
      definitionRevision: input.experiment.revision,
      variantKey,
      subjectHash: input.subjectHash,
    });
    const stored = await this.#repository.putAssignmentIfAbsent(input.projectKey, assignment);
    if (stored.projectKey !== input.projectKey || stored.experimentKey !== input.experiment.key || stored.definitionRevision !== input.experiment.revision || stored.subjectHash !== input.subjectHash || !input.experiment.variants.some(variant => variant.key === stored.variantKey)) {
      throw new AllocationError('assignment_mismatch');
    }
    return stored;
  }
}

/** Thompson sampling draws each arm's reward rate and serves the largest sample. */
export function chooseVariant(snapshot: AllocationSnapshot, uniform: UniformRandom = secureUniform): string {
  let winner = snapshot.variants[0];
  if (winner === undefined) throw new AllocationError('snapshot_mismatch');
  let winningSample = betaSample(1 + winner.successes, 1 + winner.failures, uniform);
  for (const arm of snapshot.variants.slice(1)) {
    const sample = betaSample(1 + arm.successes, 1 + arm.failures, uniform);
    if (sample > winningSample) {
      winner = arm;
      winningSample = sample;
    }
  }
  return winner.variantKey;
}

function betaSample(alpha: number, beta: number, uniform: UniformRandom): number {
  const alphaGamma = gammaSample(alpha, uniform);
  const betaGamma = gammaSample(beta, uniform);
  return alphaGamma / (alphaGamma + betaGamma);
}

function gammaSample(shape: number, uniform: UniformRandom): number {
  if (shape < 1) return gammaSample(shape + 1, uniform) * uniform() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const first = checkedUniform(uniform);
    const second = checkedUniform(uniform);
    const normal = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
    const base = 1 + c * normal;
    if (base <= 0) continue;
    const volume = base ** 3;
    const acceptance = checkedUniform(uniform);
    if (acceptance < 1 - 0.0331 * normal ** 4 || Math.log(acceptance) < 0.5 * normal ** 2 + d * (1 - volume + Math.log(volume))) {
      return d * volume;
    }
  }
  throw new AllocationError('sampling_failed');
}

function checkedUniform(uniform: UniformRandom): number {
  const value = uniform();
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new AllocationError('invalid_random_source');
  return value;
}

function secureUniform(): number {
  const word = new Uint32Array(1);
  globalThis.crypto.getRandomValues(word);
  const value = word[0];
  if (value === undefined) throw new AllocationError('invalid_random_source');
  return (value + 0.5) / 4_294_967_296;
}
