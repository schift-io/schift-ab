import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ExperimentContractError, warehouseRowToEvent } from '../src/index.js';

const SUBJECT = `h1:${'b'.repeat(64)}`;

const READ_ROW = {
  _event_id: 'evt-1',
  _occurred_at: '2026-01-01T00:00:00.123456Z',
  _received_at: '2026-01-01T00:00:01Z',
  _tenant: 'tenant-a',
  project_key: 'site-a',
  event_kind: 'signal',
  experiment_key: 'landing.hero',
  definition_revision: 1,
  assignment_id: 'asg-1',
  variant_key: 'benefit',
  subject_hash: SUBJECT,
  linked_subject_hash: null,
  signal_key: 'signup_completed',
  signal_kind: 'outcome',
  signal_value: null,
  attribution_window_seconds: 3600,
  surface_key: 'landing.home',
  properties_json: '{"plan":"pro"}',
};

describe('warehouseRowToEvent', () => {
  test('restores the recorded event from envelope fields', () => {
    const event = warehouseRowToEvent(READ_ROW);
    expect(event.eventId).toBe('evt-1');
    expect(event.occurredAt).toBe('2026-01-01T00:00:00.123456Z');
    expect(event.variantKey).toBe('benefit');
    expect(event.properties).toEqual({ plan: 'pro' });
  });

  test('treats omitted nullable columns as null', () => {
    const { linked_subject_hash: _, signal_value: __, properties_json: ___, ...sparse } = READ_ROW;
    const event = warehouseRowToEvent(sparse);
    expect(event.linkedSubjectHash).toBeNull();
    expect(event.signalValue).toBeNull();
    expect(event.properties).toBeNull();
  });

  test('rejects rows without the read envelope', () => {
    const { _event_id: eventId, _occurred_at: occurredAt, ...columns } = READ_ROW;
    expect(() => warehouseRowToEvent({ ...columns, event_id: eventId, occurred_at: occurredAt })).toThrow(ExperimentContractError);
  });

  test('rejects malformed properties_json', () => {
    expect(() => warehouseRowToEvent({ ...READ_ROW, properties_json: '{' })).toThrow(ExperimentContractError);
  });
});

describe('contracts/experiment-events.json', () => {
  const body = JSON.parse(readFileSync(new URL('../contracts/experiment-events.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  test('is exactly the schema declaration body warehouse-log accepts', () => {
    expect(Object.keys(body)).toEqual(['columns']);
    const columns = body['columns'] as Record<string, unknown>[];
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) expect(Object.keys(column).sort()).toEqual(['name', 'nullable', 'type']);
  });

  test('declares every written column except the envelope-seeded ones', () => {
    const declared = (body['columns'] as { name: string }[]).map(column => column.name).sort();
    const readColumns = Object.keys(READ_ROW).filter(key => !key.startsWith('_')).sort();
    expect(declared).toEqual(readColumns);
  });
});
