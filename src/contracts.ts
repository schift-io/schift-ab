import { z } from 'zod';

const key = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const opaqueHash = z.string().min(16).max(256).regex(/^[a-zA-Z0-9:_-]+$/);
export const SubjectHashSchema = opaqueHash;
const seconds = z.number().int().min(0).max(2_592_000);

export const SignalKindSchema = z.enum(['choice', 'outcome']);
export const SignalModeSchema = z.enum(['occurrence', 'value']);
export const SignalDefinitionSchema = z.object({
  key,
  kind: SignalKindSchema,
  mode: SignalModeSchema,
  attributionWindowSeconds: seconds,
}).strict().readonly();
export const ProviderAssignmentSchema = z.object({
  variantKey: key,
  assignmentId: key.optional(),
}).strict().readonly();

export const ExperimentDefinitionSchema = z.object({
  key,
  revision: z.number().int().min(1),
  hypothesis: z.string().min(1).max(1000),
  surface: key,
  variants: z.array(z.object({ key, label: z.string().min(1).max(120) }).strict().readonly()).min(2).max(8),
  reward: SignalDefinitionSchema,
  secondarySignals: z.array(SignalDefinitionSchema).max(16).default([]),
}).strict().superRefine((definition, context) => {
  const signalKeys = [definition.reward.key, ...definition.secondarySignals.map(signal => signal.key)];
  if (new Set(signalKeys).size !== signalKeys.length) {
    context.addIssue({ code: 'custom', path: ['secondarySignals'], message: 'Signal keys must be unique' });
  }
  if (new Set(definition.variants.map(variant => variant.key)).size !== definition.variants.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: 'Variant keys must be unique' });
  }
}).readonly();

export type ExperimentDefinition = z.infer<typeof ExperimentDefinitionSchema>;
export type SignalDefinition = z.infer<typeof SignalDefinitionSchema>;
export type SignalKind = z.infer<typeof SignalKindSchema>;
export type SignalMode = z.infer<typeof SignalModeSchema>;

export const EventKindSchema = z.enum(['definition', 'assignment', 'exposure', 'signal', 'identity_link']);
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(JsonValueSchema), z.record(JsonValueSchema),
]));
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const ExperimentEventSchema = z.object({
  schema: z.literal('schift.experiment.event.v1'),
  eventId: key,
  projectKey: key,
  eventKind: EventKindSchema,
  experimentKey: key.nullable(),
  definitionRevision: z.number().int().min(1).nullable(),
  assignmentId: key.nullable(),
  variantKey: key.nullable(),
  subjectHash: opaqueHash.nullable(),
  linkedSubjectHash: opaqueHash.nullable(),
  signalKey: key.nullable(),
  signalKind: SignalKindSchema.nullable(),
  signalValue: z.number().finite().nullable(),
  attributionWindowSeconds: seconds.nullable(),
  surfaceKey: key.nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  properties: JsonValueSchema.nullable(),
}).strict().readonly();
export type ExperimentEvent = z.infer<typeof ExperimentEventSchema>;

/** Row shape accepted by `POST /v1/data/custom/experiments/events`. */
export type WarehouseLogEventRow = Readonly<{
  event_id: string;
  occurred_at: string;
  project_key: string;
  event_kind: z.infer<typeof EventKindSchema>;
  experiment_key: string | null;
  definition_revision: number | null;
  assignment_id: string | null;
  variant_key: string | null;
  subject_hash: string | null;
  linked_subject_hash: string | null;
  signal_key: string | null;
  signal_kind: z.infer<typeof SignalKindSchema> | null;
  signal_value: number | null;
  attribution_window_seconds: number | null;
  surface_key: string | null;
  properties_json: string | null;
}>;

export type Assignment = Readonly<{
  assignmentId: string;
  experimentKey: string;
  definitionRevision: number;
  variantKey: string;
  subjectHash: string;
}>;

export interface VariantProvider {
  /** Resolve a variant without marking it exposed; render the result first. */
  assign(input: Readonly<{
    experiment: ExperimentDefinition;
    subjectHash: string;
  }>): Promise<Readonly<{ variantKey: string; assignmentId?: string }>>;
  recordExposure(assignment: Assignment): void | Promise<void>;
  recordSignal(input: Readonly<{
    assignment: Assignment;
    signal: SignalDefinition;
    value?: number;
  }>): void | Promise<void>;
}

export interface EventSink {
  writeBatch(rows: readonly WarehouseLogEventRow[]): Promise<void>;
}

export class ExperimentContractError extends Error {
  override readonly name = 'ExperimentContractError';
  constructor(readonly reason: 'invalid_definition' | 'invalid_subject_hash' | 'unknown_variant' | 'unknown_signal' | 'invalid_signal_value' | 'invalid_properties') {
    super(reason);
  }
}
