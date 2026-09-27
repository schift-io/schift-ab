import {
  ExperimentContractError,
  ExperimentDefinitionSchema,
  ExperimentEventSchema,
  ProviderAssignmentSchema,
  SubjectHashSchema,
} from './contracts.js';
import type {
  Assignment,
  EventSink,
  ExperimentDefinition,
  ExperimentEvent,
  JsonValue,
  SignalDefinition,
  VariantProvider,
  WarehouseLogEventRow,
} from './contracts.js';

export type ExperimentClientOptions = Readonly<{
  projectKey: string;
  provider: VariantProvider;
  sink: EventSink;
  batchSize?: number;
  maxQueueSize?: number;
  clock?: () => Date;
  createId?: () => string;
}>;

type EventFields = Readonly<{
  eventKind: ExperimentEvent['eventKind'];
  subjectHash?: string | null;
  experimentKey?: string | null;
  definitionRevision?: number | null;
  assignmentId?: string | null;
  variantKey?: string | null;
  linkedSubjectHash?: string | null;
  signal?: SignalDefinition;
  signalValue?: number | null;
  surfaceKey?: string | null;
  properties?: JsonValue | null;
}>;

/** Queues assignment and behavior facts; it does not implement an allocation algorithm. */
export class ExperimentClient {
  readonly #projectKey: string;
  readonly #provider: VariantProvider;
  readonly #sink: EventSink;
  readonly #batchSize: number;
  readonly #maxQueueSize: number;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #queue: ExperimentEvent[] = [];
  #flushing: Promise<void> | undefined;
  #droppedEvents = 0;

  constructor(options: ExperimentClientOptions) {
    this.#projectKey = options.projectKey;
    this.#provider = options.provider;
    this.#sink = options.sink;
    this.#batchSize = options.batchSize ?? 100;
    this.#maxQueueSize = options.maxQueueSize ?? 10_000;
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 1000) {
      throw new RangeError('batchSize must be between 1 and 1000');
    }
    if (!Number.isInteger(this.#maxQueueSize) || this.#maxQueueSize < this.#batchSize || this.#maxQueueSize > 100_000) {
      throw new RangeError('maxQueueSize must be between batchSize and 100000');
    }
  }

  /** Persist the hypothesis, variants, reward definition, and revision for later reports. */
  register(definitionInput: unknown): ExperimentDefinition {
    const parsed = ExperimentDefinitionSchema.safeParse(definitionInput);
    if (!parsed.success) throw new ExperimentContractError('invalid_definition');
    const definition = parsed.data;
    this.#record({
      eventKind: 'definition', subjectHash: null,
      experimentKey: definition.key, definitionRevision: definition.revision,
      surfaceKey: definition.surface, properties: definition,
    });
    return definition;
  }

  async assign(definitionInput: unknown, subjectHash: string): Promise<Assignment> {
    const parsed = ExperimentDefinitionSchema.safeParse(definitionInput);
    if (!parsed.success) throw new ExperimentContractError('invalid_definition');
    const parsedSubjectHash = SubjectHashSchema.safeParse(subjectHash);
    if (!parsedSubjectHash.success) throw new ExperimentContractError('invalid_subject_hash');
    const definition = parsed.data;
    const rawAssignment = await this.#provider.assign({ experiment: definition, subjectHash: parsedSubjectHash.data });
    const result = ProviderAssignmentSchema.safeParse(rawAssignment);
    if (!result.success || !definition.variants.some(variant => variant.key === result.data.variantKey)) {
      throw new ExperimentContractError('unknown_variant');
    }
    const assignment: Assignment = {
      assignmentId: result.data.assignmentId ?? this.#createId(),
      experimentKey: definition.key,
      definitionRevision: definition.revision,
      variantKey: result.data.variantKey,
      subjectHash: parsedSubjectHash.data,
    };
    this.#record({
      eventKind: 'assignment', subjectHash, experimentKey: definition.key,
      definitionRevision: definition.revision,
      assignmentId: assignment.assignmentId, variantKey: assignment.variantKey,
      surfaceKey: definition.surface,
    });
    return assignment;
  }

  /** Record only after the assigned variant was actually rendered or shown. */
  async expose(assignment: Assignment, surfaceKey: string): Promise<void> {
    this.#record({ ...assignment, eventKind: 'exposure', surfaceKey });
    await this.#provider.recordExposure(assignment);
  }

  /** Record a declared choice or downstream outcome against the original assignment. */
  async signal(
    definitionInput: unknown,
    assignment: Assignment,
    signalKey: string,
    value?: number,
    properties?: JsonValue,
  ): Promise<void> {
    const parsed = ExperimentDefinitionSchema.safeParse(definitionInput);
    if (!parsed.success || parsed.data.key !== assignment.experimentKey || parsed.data.revision !== assignment.definitionRevision) {
      throw new ExperimentContractError('invalid_definition');
    }
    const definition = parsed.data;
    const signal = [definition.reward, ...definition.secondarySignals].find(item => item.key === signalKey);
    if (!signal) throw new ExperimentContractError('unknown_signal');
    if ((signal.mode === 'value' && value === undefined) || (signal.mode === 'occurrence' && value !== undefined)) {
      throw new ExperimentContractError('invalid_signal_value');
    }
    this.#record({
      ...assignment, eventKind: 'signal', signal,
      definitionRevision: definition.revision,
      ...(value !== undefined ? { signalValue: value } : {}),
      surfaceKey: definition.surface,
      ...(properties !== undefined ? { properties } : {}),
    });
    await this.#provider.recordSignal({
      assignment,
      signal,
      ...(value !== undefined ? { value } : {}),
    });
  }

  /** Link anonymous and authenticated pseudonyms; raw IDs must never enter this SDK. */
  linkIdentity(anonymousSubjectHash: string, userSubjectHash: string): void {
    const anonymousSubject = SubjectHashSchema.safeParse(anonymousSubjectHash);
    const userSubject = SubjectHashSchema.safeParse(userSubjectHash);
    if (!anonymousSubject.success || !userSubject.success) throw new ExperimentContractError('invalid_subject_hash');
    this.#record({
      eventKind: 'identity_link', subjectHash: anonymousSubject.data,
      linkedSubjectHash: userSubject.data,
    });
  }

  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#drain().finally(() => { this.#flushing = undefined; });
    return this.#flushing;
  }

  health(): Readonly<{ queuedEvents: number; droppedEvents: number }> {
    return { queuedEvents: this.#queue.length, droppedEvents: this.#droppedEvents };
  }

  #record(fields: EventFields): void {
    if (this.#queue.length >= this.#maxQueueSize) {
      this.#droppedEvents += 1;
      return;
    }
    const event = ExperimentEventSchema.parse({
      schema: 'schift.experiment.event.v1', eventId: this.#createId(),
      projectKey: this.#projectKey, eventKind: fields.eventKind,
      experimentKey: fields.experimentKey ?? null,
      definitionRevision: fields.definitionRevision ?? null,
      assignmentId: fields.assignmentId ?? null,
      variantKey: fields.variantKey ?? null,
      subjectHash: fields.subjectHash ?? null,
      linkedSubjectHash: fields.linkedSubjectHash ?? null,
      signalKey: fields.signal?.key ?? null,
      signalKind: fields.signal?.kind ?? null,
      signalValue: fields.signalValue ?? null,
      attributionWindowSeconds: fields.signal?.attributionWindowSeconds ?? null,
      surfaceKey: fields.surfaceKey ?? null,
      occurredAt: this.#clock().toISOString(),
      properties: fields.properties ?? null,
    });
    this.#queue.push(event);
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const events = this.#queue.slice(0, this.#batchSize);
      const rows = events.map(event => this.#toWarehouseRow(event));
      await this.#sink.writeBatch(rows);
      this.#queue.splice(0, events.length);
    }
  }

  #toWarehouseRow(event: ExperimentEvent): WarehouseLogEventRow {
    const propertiesJson = event.properties === null ? null : JSON.stringify(event.properties);
    if (propertiesJson === undefined) throw new ExperimentContractError('invalid_properties');
    return {
      event_id: event.eventId,
      occurred_at: event.occurredAt,
      project_key: event.projectKey,
      event_kind: event.eventKind,
      experiment_key: event.experimentKey,
      definition_revision: event.definitionRevision,
      assignment_id: event.assignmentId,
      variant_key: event.variantKey,
      subject_hash: event.subjectHash,
      linked_subject_hash: event.linkedSubjectHash,
      signal_key: event.signalKey,
      signal_kind: event.signalKind,
      signal_value: event.signalValue,
      attribution_window_seconds: event.attributionWindowSeconds,
      surface_key: event.surfaceKey,
      properties_json: propertiesJson,
    };
  }
}

export function defineExperiment(input: unknown): ExperimentDefinition {
  const result = ExperimentDefinitionSchema.safeParse(input);
  if (!result.success) throw new ExperimentContractError('invalid_definition');
  return result.data;
}
