import { describe, expect, test } from 'bun:test';
import { ExperimentClient, defineExperiment } from '../src/index.js';
import type { AllocationEngine, Assignment, WarehouseLogEventRow } from '../src/index.js';

const subjectHash = `h1:${'a'.repeat(64)}`;
const definition = defineExperiment({
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

class FakeAllocator implements AllocationEngine {
  async assign(input: Readonly<{ projectKey: string; experiment: typeof definition; subjectHash: string }>): Promise<Assignment> {
    return {
      projectKey: input.projectKey,
      assignmentId: 'assignment-1',
      experimentKey: input.experiment.key,
      definitionRevision: input.experiment.revision,
      variantKey: 'benefit',
      subjectHash: input.subjectHash,
    };
  }
}

class MemorySink {
  readonly rows: WarehouseLogEventRow[] = [];
  async writeBatch(rows: readonly WarehouseLogEventRow[]): Promise<void> {
    this.rows.push(...rows);
  }
}

describe('ExperimentClient', () => {
  test('emits definition, assignment, real exposure, and reward rows', async () => {
    const sink = new MemorySink();
    const client = new ExperimentClient({ projectKey: 'site-a', allocator: new FakeAllocator(), sink });
    client.register(definition);
    const assignment = await client.assign(definition, subjectHash);
    client.expose(definition, assignment);
    client.signal(definition, assignment, 'signup_completed');
    await client.flush();

    expect(sink.rows.map(row => row.event_kind)).toEqual(['definition', 'assignment', 'exposure', 'signal']);
    expect(sink.rows.slice(1).every(row => row.project_key === 'site-a')).toBe(true);
    expect(sink.rows[3]?.assignment_id).toBe('assignment-1');
  });

  test('reports bounded queue drops through the callback', async () => {
    const sink = new MemorySink();
    const dropped: string[] = [];
    const client = new ExperimentClient({
      projectKey: 'site-a',
      allocator: new FakeAllocator(),
      sink,
      batchSize: 1,
      maxQueueSize: 1,
      onEventDropped: eventKind => dropped.push(eventKind),
    });
    client.register(definition);
    await client.assign(definition, subjectHash);

    expect(client.health().droppedEvents).toBe(1);
    expect(dropped).toEqual(['assignment']);
  });
});
