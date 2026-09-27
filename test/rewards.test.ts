import { describe, expect, test } from 'bun:test';
import {
  AllocationSnapshotSchema,
  ExperimentEventSchema,
  RewardAggregateSchema,
  RewardBatchError,
  aggregateMaturedRewards,
  applyRewardAggregate,
  defineExperiment,
} from '../src/index.js';
import type { ExperimentDefinition, ExperimentEvent } from '../src/index.js';

const projectKey = 'site-a';
const definition: ExperimentDefinition = defineExperiment({
  key: 'landing.hero',
  revision: 1,
  hypothesis: 'Benefit copy increases completed signups.',
  surface: 'landing.home',
  variants: [
    { key: 'control', label: 'Current' },
    { key: 'benefit', label: 'Benefit' },
  ],
  reward: {
    key: 'signup_completed',
    kind: 'outcome',
    mode: 'occurrence',
    attributionWindowSeconds: 3600,
  },
  secondarySignals: [],
});

const baseEvent = {
  schema: 'schift.experiment.event.v1' as const,
  projectKey,
  experimentKey: definition.key,
  definitionRevision: definition.revision,
  assignmentId: null,
  variantKey: null,
  subjectHash: null,
  linkedSubjectHash: null,
  signalKey: null,
  signalKind: null,
  signalValue: null,
  attributionWindowSeconds: null,
  surfaceKey: definition.surface,
  properties: null,
};

function event(input: Partial<ExperimentEvent> & Pick<ExperimentEvent, 'eventId' | 'eventKind' | 'occurredAt'>): ExperimentEvent {
  return ExperimentEventSchema.parse({ ...baseEvent, ...input });
}

describe('reward aggregation', () => {
  test('counts only mature distinct exposures and matching rewards', () => {
    const events = [
      event({ eventId: 'exposure-a', eventKind: 'exposure', assignmentId: 'a1', variantKey: 'control', subjectHash: `h1:${'a'.repeat(64)}`, occurredAt: '2026-01-01T00:00:00.000Z' }),
      event({ eventId: 'exposure-a', eventKind: 'exposure', assignmentId: 'a1', variantKey: 'control', subjectHash: `h1:${'a'.repeat(64)}`, occurredAt: '2026-01-01T00:00:00.000Z' }),
      event({ eventId: 'reward-a', eventKind: 'signal', assignmentId: 'a1', variantKey: 'control', subjectHash: `h1:${'a'.repeat(64)}`, signalKey: 'signup_completed', signalKind: 'outcome', occurredAt: '2026-01-01T00:10:00.000Z' }),
      event({ eventId: 'exposure-b', eventKind: 'exposure', assignmentId: 'b1', variantKey: 'benefit', subjectHash: `h1:${'b'.repeat(64)}`, occurredAt: '2026-01-01T00:00:00.000Z' }),
      event({ eventId: 'exposure-late', eventKind: 'exposure', assignmentId: 'late', variantKey: 'benefit', subjectHash: `h1:${'c'.repeat(64)}`, occurredAt: '2026-01-01T00:30:00.000Z' }),
    ];

    const aggregate = aggregateMaturedRewards(projectKey, definition, events, '2026-01-01T01:00:00.000Z', 1, 'batch-1');

    expect(aggregate.variants).toEqual([
      { variantKey: 'control', matureExposures: 1, rewards: 1 },
      { variantKey: 'benefit', matureExposures: 1, rewards: 0 },
    ]);
  });

  test('rejects a conflicting retry and a cumulative regression', () => {
    const previous = AllocationSnapshotSchema.parse({
      projectKey,
      experimentKey: definition.key,
      definitionRevision: definition.revision,
      batchSequence: 1,
      batchId: 'batch-1',
      observedThrough: '2026-01-01T02:00:00.000Z',
      variants: [
        { variantKey: 'control', successes: 1, failures: 1 },
        { variantKey: 'benefit', successes: 0, failures: 2 },
      ],
    });
    const retry = RewardAggregateSchema.parse({
      projectKey,
      experimentKey: definition.key,
      definitionRevision: definition.revision,
      batchSequence: 1,
      batchId: 'batch-other',
      observedThrough: '2026-01-01T02:00:00.000Z',
      variants: [
        { variantKey: 'control', matureExposures: 2, rewards: 1 },
        { variantKey: 'benefit', matureExposures: 2, rewards: 0 },
      ],
    });
    expect(() => applyRewardAggregate(projectKey, previous, definition, retry)).toThrow(RewardBatchError);
    const regression = { ...retry, batchSequence: 2, batchId: 'batch-2', variants: [
      { variantKey: 'control', matureExposures: 1, rewards: 1 },
      { variantKey: 'benefit', matureExposures: 2, rewards: 0 },
    ] };
    expect(() => applyRewardAggregate(projectKey, previous, definition, regression)).toThrow(RewardBatchError);
  });
});
