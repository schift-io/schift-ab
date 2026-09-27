import { describe, expect, test } from 'bun:test';
import {
  AdaptiveBandit,
  AllocationError,
  AllocationSnapshotSchema,
  type AllocationRepository,
  type Assignment,
  type ExperimentDefinition,
  defineExperiment,
} from '../src/index.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const SUBJECT = `h1:${'a'.repeat(64)}`;

function definition(): ExperimentDefinition {
  return defineExperiment({
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
}

class MemoryRepository implements AllocationRepository {
  readonly snapshots = new Map<string, ReturnType<typeof AllocationSnapshotSchema.parse>>();
  readonly assignments = new Map<string, Assignment>();

  #key(projectKey: string, experimentKey: string, revision: number, subjectHash?: string): string {
    return [projectKey, experimentKey, revision, subjectHash ?? 'snapshot'].join(':');
  }

  async readSnapshot(projectKey: string, experimentKey: string, revision: number) {
    return this.snapshots.get(this.#key(projectKey, experimentKey, revision)) ?? null;
  }

  async findAssignment(projectKey: string, experimentKey: string, revision: number, subjectHash: string) {
    return this.assignments.get(this.#key(projectKey, experimentKey, revision, subjectHash)) ?? null;
  }

  async putAssignmentIfAbsent(projectKey: string, assignment: Assignment) {
    const key = this.#key(projectKey, assignment.experimentKey, assignment.definitionRevision, assignment.subjectHash);
    const existing = this.assignments.get(key);
    if (existing !== undefined) return existing;
    this.assignments.set(key, assignment);
    return assignment;
  }
}

describe('AdaptiveBandit', () => {
  test('keeps assignments sticky and scopes identical subjects by project', async () => {
    const repository = new MemoryRepository();
    const bandit = new AdaptiveBandit(repository, { clock: () => NOW, uniform: () => 0.5 });
    const experiment = definition();

    const first = await bandit.assign({ projectKey: 'site-a', experiment, subjectHash: SUBJECT });
    const repeated = await bandit.assign({ projectKey: 'site-a', experiment, subjectHash: SUBJECT });
    const otherProject = await bandit.assign({ projectKey: 'site-b', experiment, subjectHash: SUBJECT });

    expect(repeated).toEqual(first);
    expect(otherProject.projectKey).toBe('site-b');
    expect(otherProject.assignmentId).not.toBe(first.assignmentId);
  });

  test('rejects a stale posterior snapshot', async () => {
    const repository = new MemoryRepository();
    repository.snapshots.set('site-a:landing.hero:1:snapshot', AllocationSnapshotSchema.parse({
      projectKey: 'site-a',
      experimentKey: 'landing.hero',
      definitionRevision: 1,
      batchSequence: 1,
      batchId: 'batch-1',
      observedThrough: '2025-12-31T00:00:00.000Z',
      variants: [
        { variantKey: 'control', successes: 1, failures: 1 },
        { variantKey: 'benefit', successes: 0, failures: 2 },
      ],
    }));
    const bandit = new AdaptiveBandit(repository, { clock: () => NOW, maxSnapshotAgeMs: 1000 });

    await expect(bandit.assign({ projectKey: 'site-a', experiment: definition(), subjectHash: SUBJECT })).rejects.toMatchObject({
      reason: 'snapshot_stale',
    } satisfies Partial<AllocationError>);
  });
});
