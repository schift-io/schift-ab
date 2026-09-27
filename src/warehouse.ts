import { z } from 'zod';
import { ExperimentContractError, ExperimentEventSchema, JsonValueSchema } from './contracts.js';
import type { ExperimentEvent } from './contracts.js';

/**
 * Row shape returned by `GET /v1/data/custom/experiments/events`.
 *
 * warehouse-log moves the written `event_id` and `occurred_at` into its
 * envelope, so reads carry `_event_id` and `_occurred_at` instead. Other
 * envelope fields (`_tenant`, `_received_at`, ...) are ignored.
 */
const nullableString = z.string().nullish().transform(value => value ?? null);
const nullableNumber = z.number().nullish().transform(value => value ?? null);

export const WarehouseLogReadRowSchema = z.object({
  _event_id: z.string(),
  _occurred_at: z.string(),
  project_key: z.string(),
  event_kind: z.string(),
  experiment_key: nullableString,
  definition_revision: nullableNumber,
  assignment_id: nullableString,
  variant_key: nullableString,
  subject_hash: nullableString,
  linked_subject_hash: nullableString,
  signal_key: nullableString,
  signal_kind: nullableString,
  signal_value: nullableNumber,
  attribution_window_seconds: nullableNumber,
  surface_key: nullableString,
  properties_json: nullableString,
}).passthrough();
export type WarehouseLogReadRow = z.input<typeof WarehouseLogReadRowSchema>;

/** Convert one warehouse-log read row back into the event the SDK recorded. */
export function warehouseRowToEvent(input: unknown): ExperimentEvent {
  const parsed = WarehouseLogReadRowSchema.safeParse(input);
  if (!parsed.success) throw new ExperimentContractError('invalid_warehouse_row');
  const row = parsed.data;
  let properties: unknown = null;
  if (row.properties_json !== null) {
    try {
      properties = JSON.parse(row.properties_json);
    } catch {
      throw new ExperimentContractError('invalid_warehouse_row');
    }
    if (!JsonValueSchema.safeParse(properties).success) throw new ExperimentContractError('invalid_warehouse_row');
  }
  const event = ExperimentEventSchema.safeParse({
    schema: 'schift.experiment.event.v1',
    eventId: row._event_id,
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
    occurredAt: row._occurred_at,
    properties,
  });
  if (!event.success) throw new ExperimentContractError('invalid_warehouse_row');
  return event.data;
}
