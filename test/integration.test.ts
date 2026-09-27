import { describe, expect, test } from 'bun:test';
import {
  AdaptiveBandit,
  BatchRewardUpdater,
  ExperimentClient,
  ExperimentEventSchema,
  type AllocationRepository,
  type AllocationSnapshot,
  type Assignment,
  type ExperimentDefinition,
  type RewardSnapshotStore,
  aggregateMaturedRewards,
  defineExperiment,
} from '../src/index.js';
import type { WarehouseLogEventRow } from '../src/index.js';

const PROJECT = 'site-a';
const SUBJECT = `h1:${'a'.repeat(64)}`;
const START = Date.parse('2026-01-01T00:00:00.000Z');

const EXPERIMENT: ExperimentDefinition = defineExperiment({
  key: 'landing.hero',
  revision: 1,
  hypothesis: 'Benefit copy increases completed signups.',
  surface: 'landing.home',
  variants: [
    { key: 'control', label: 'Current' },
    { key: 'benefit', label: 'Benefit' },
  ],
  reward: { key: 'signup_completed', kind: 'outcome', mode: 'occurrence', attributionWindowSeconds: 3600 },
  secondarySignals: [],
});

class IntegrationStore implements AllocationRepository, RewardSnapshotStore {
  readonly snapshots = new Map<string, AllocationSnapshot>();
  readonly assignments = new Map<string, Assignment>();
  #key(project: string, experiment: string, revision: number, subject = 'snapshot'): string {
    return [project, experiment, revision, subject].join(':');
  }
  async readSnapshot(project: string, experiment: string, revision: number) {
    return this.snapshots.get(this.#key(project, experiment, revision)) ?? null;
  }
  async read(project: string, experiment: string, revision: number) {
    return this.readSnapshot(project, experiment, revision);
  }
  async findAssignment(project: string, experiment: string, revision: number, subject: string) {
    return this.assignments.get(this.#key(project, experiment, revision, subject)) ?? null;
  }
  async putAssignmentIfAbsent(project: string, assignment: Assignment) {
    const key = this.#key(project, assignment.experimentKey, assignment.definitionRevision, assignment.subjectHash);
    const existing = this.assignments.get(key);
    if (existing !== undefined) return existing;
    this.assignments.set(key, assignment);
    return assignment;
  }
  async compareAndSet(input: Readonly<{ projectKey: string; experimentKey: string; definitionRevision: number; expectedBatchSequence: number | null; snapshot: AllocationSnapshot }>) {
    const key = this.#key(input.projectKey, input.experimentKey, input.definitionRevision);
    const current = this.snapshots.get(key);
    const currentSequence = current?.batchSequence ?? null;
    if (currentSequence !== input.expectedBatchSequence) return false;
    this.snapshots.set(key, input.snapshot);
    return true;
  }
}

class WarehouseLogBatch implements DatabaseSink {
  readonly rows: WarehouseLogEventRow[] = [];
  async writeBatch(rows: readonly WarehouseLogEventRow[]): Promise<void> {
    this.rows.push(...rows);
  }
}

interface DatabaseSink {
  writeBatch(rows: readonly WarehouseLogEventRow[]): Promise<void>;
}

function eventFromRow(row: WarehouseLogEventRow) {
  return ExperimentEventSchema.parse({
    schema: 'schift.experiment.event.v1',
    eventId: row.event_id,
    projectKey: row.project_key,
    eventKind: row.event_kind,
    experimentKey: row.experiment_key,
    definitionRevision: row.definition_revision,
    assignmentId: row.assignment_id,
    variantKey: row.variant_key,
    subjectHash: row.subject_hash,
    linkedSubjectHash: row.linked_subject_hash,
    signalKey: row.signal_key,
    signalKind: row.signal_kind,
    signalValue: row.signal_value,
    attributionWindowSeconds: row.attribution_window_seconds,
    surfaceKey: row.surface_key,
    occurredAt: row.occurred_at,
    properties: null,
  });
}

describe('Schift-AB integration flow', () => {
  test('ships SDK rows through warehouse shape and updates the posterior', async () => {
    const store = new IntegrationStore();
    const sink = new WarehouseLogBatch();
    let now = START;
    const allocator = new AdaptiveBandit(store, { clock: () => now, uniform: () => 0.5 });
    const client = new ExperimentClient({ projectKey: PROJECT, allocator, sink, clock: () => new Date(now) });

    client.register(EXPERIMENT);
    const assignment = await client.assign(EXPERIMENT, SUBJECT);
    client.expose(EXPERIMENT, assignment);
    now += 5 * 60 * 1000;
    client.signal(EXPERIMENT, assignment, 'signup_completed');
    await client.flush();

    const events = sink.rows.map(eventFromRow);
    const aggregate = aggregateMaturedRewards(PROJECT, EXPERIMENT, events, '2026-01-01T02:00:00.000Z', 1, 'batch-1');
    const updater = new BatchRewardUpdater(store);
    const snapshot = await updater.apply(PROJECT, EXPERIMENT, aggregate);
    const winningArm = snapshot.variants.find(variant => variant.variantKey === assignment.variantKey);

    expect(sink.rows.map(row => row.event_kind)).toEqual(['definition', 'assignment', 'exposure', 'signal']);
    expect(aggregate.variants.reduce((total, variant) => total + variant.rewards, 0)).toBe(1);
    expect(winningArm).toMatchObject({ successes: 1, failures: 0 });
    expect(store.snapshots.get(`${PROJECT}:${EXPERIMENT.key}:${EXPERIMENT.revision}:snapshot`)).toEqual(snapshot);
  });
});
