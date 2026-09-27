# Copyright (c) 2026 Schift

"""Thin Python client for Schift-AB assignment and warehouse event contracts."""

from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import uuid4

from pydantic import ValidationError

from schift_ab.config import (
    MAX_BATCH_SIZE,
    MAX_QUEUE_SIZE,
    AssignmentGateway,
    ClientErrorReason,
    ClientHealth,
    ClientOptions,
    EventSink,
    ExperimentClientError,
    KeyStringModel,
)
from schift_ab.contracts import (
    Assignment,
    Event,
    ExperimentDefinition,
    IdentityContractError,
    ProjectKey,
    SubjectHash,
    subject_hash,
    utc_now,
)
from schift_ab.events import EventDraft, to_warehouse_row

if TYPE_CHECKING:
    from collections.abc import Callable

    from pydantic import JsonValue

    from schift_ab.contracts import EventKind


class ExperimentClient:
    """Mutable queue is intentional: events are buffered into bounded writes."""

    _project_key: ProjectKey
    _assignment_gateway: AssignmentGateway
    _event_sink: EventSink
    _batch_size: int
    _max_queue_size: int
    _dropped_events: int
    _on_event_dropped: Callable[[EventKind], None] | None

    def __init__(self, options: ClientOptions) -> None:
        """Validate queue limits and connect caller-owned collaborators."""
        if options.batch_size < 1 or options.batch_size > MAX_BATCH_SIZE:
            raise ExperimentClientError(ClientErrorReason.INVALID_BATCH_SIZE)
        if (
            options.max_queue_size < options.batch_size
            or options.max_queue_size > MAX_QUEUE_SIZE
        ):
            raise ExperimentClientError(ClientErrorReason.INVALID_BATCH_SIZE)
        try:
            parsed_project_key = KeyStringModel(value=options.project_key).value
            self._project_key = ProjectKey(parsed_project_key)
        except ValidationError as error:
            raise ExperimentClientError(
                ClientErrorReason.INVALID_DEFINITION,
            ) from error
        self._assignment_gateway = options.assignment_gateway
        self._event_sink = options.event_sink
        self._batch_size = options.batch_size
        self._max_queue_size = options.max_queue_size
        self._on_event_dropped = options.on_event_dropped
        self._queue: list[Event] = []
        self._dropped_events = 0

    def register(self, experiment: ExperimentDefinition) -> ExperimentDefinition:
        """Record a deliberate hypothesis/variant/reward revision for reports."""
        self._record(
            EventDraft(
                event_kind="definition",
                experiment_key=experiment.key,
                definition_revision=experiment.revision,
                surface_key=experiment.surface,
                properties=experiment.model_dump(mode="json", by_alias=True),
            ),
        )
        return experiment

    def assign(
        self,
        experiment: ExperimentDefinition,
        subject: SubjectHash,
    ) -> Assignment:
        """Fetch a sticky variant and queue its assignment fact."""
        try:
            parsed_subject = subject_hash(str(subject))
        except IdentityContractError as error:
            raise ExperimentClientError(
                ClientErrorReason.INVALID_SUBJECT_HASH,
            ) from error
        result = self._assignment_gateway.assign(
            self._project_key,
            experiment,
            parsed_subject,
        )
        allowed_variants = {variant.key for variant in experiment.variants}
        if (
            result.project_key != self._project_key
            or result.experiment_key != experiment.key
            or result.definition_revision != experiment.revision
            or result.subject_hash != parsed_subject
            or result.variant_key not in allowed_variants
        ):
            raise ExperimentClientError(ClientErrorReason.INVALID_ASSIGNMENT)
        assignment = result
        self._record(
            EventDraft(
                event_kind="assignment",
                experiment_key=experiment.key,
                definition_revision=experiment.revision,
                assignment_id=assignment.assignment_id,
                variant_key=assignment.variant_key,
                subject_hash=parsed_subject,
                surface_key=experiment.surface,
            ),
        )
        return assignment

    def expose(
        self,
        experiment: ExperimentDefinition,
        assignment: Assignment,
    ) -> None:
        """Queue exposure after its declared variant was actually displayed."""
        if (
            assignment.project_key != self._project_key
            or assignment.experiment_key != experiment.key
            or assignment.definition_revision != experiment.revision
            or assignment.variant_key
            not in {variant.key for variant in experiment.variants}
        ):
            raise ExperimentClientError(ClientErrorReason.INVALID_ASSIGNMENT)
        self._record(
            EventDraft(
                event_kind="exposure",
                experiment_key=assignment.experiment_key,
                definition_revision=assignment.definition_revision,
                assignment_id=assignment.assignment_id,
                variant_key=assignment.variant_key,
                subject_hash=assignment.subject_hash,
                surface_key=experiment.surface,
            ),
        )

    def signal(
        self,
        experiment: ExperimentDefinition,
        assignment: Assignment,
        signal_key: str,
        value: float | None = None,
        properties: JsonValue | None = None,
    ) -> None:
        """Queue a declared choice/reward signal against its original assignment."""
        if (
            assignment.project_key != self._project_key
            or experiment.key != assignment.experiment_key
            or experiment.revision != assignment.definition_revision
        ):
            raise ExperimentClientError(ClientErrorReason.INVALID_DEFINITION)
        if assignment.variant_key not in {
            variant.key for variant in experiment.variants
        }:
            raise ExperimentClientError(ClientErrorReason.INVALID_ASSIGNMENT)
        signal = next(
            (
                item
                for item in (experiment.reward, *experiment.secondary_signals)
                if item.key == signal_key
            ),
            None,
        )
        if signal is None:
            raise ExperimentClientError(ClientErrorReason.UNKNOWN_SIGNAL)
        match signal.mode:
            case "value":
                valid_value = value is not None
            case "occurrence":
                valid_value = value is None
        if not valid_value:
            raise ExperimentClientError(ClientErrorReason.INVALID_SIGNAL_VALUE)
        self._record(
            EventDraft(
                event_kind="signal",
                experiment_key=experiment.key,
                definition_revision=experiment.revision,
                assignment_id=assignment.assignment_id,
                variant_key=assignment.variant_key,
                subject_hash=assignment.subject_hash,
                signal_key=signal.key,
                signal_kind=signal.kind,
                signal_value=value,
                attribution_window_seconds=signal.attribution_window_seconds,
                surface_key=experiment.surface,
                properties=properties,
            ),
        )

    def link_identity(self, anonymous: SubjectHash, authenticated: SubjectHash) -> None:
        """Queue an anonymous-to-login pseudonym link without raw identifiers."""
        try:
            anonymous_hash = subject_hash(str(anonymous))
            authenticated_hash = subject_hash(str(authenticated))
        except IdentityContractError as error:
            raise ExperimentClientError(
                ClientErrorReason.INVALID_SUBJECT_HASH,
            ) from error
        self._record(
            EventDraft(
                event_kind="identity_link",
                subject_hash=anonymous_hash,
                linked_subject_hash=authenticated_hash,
            ),
        )

    def flush(self) -> None:
        """Write queued events in batches, preserving pending data on failure."""
        while self._queue:
            batch = self._queue[: self._batch_size]
            rows = [to_warehouse_row(event) for event in batch]
            self._event_sink.write_batch(rows)
            del self._queue[: len(batch)]

    def health(self) -> ClientHealth:
        """Return counters so the host can report dropped instrumentation."""
        return ClientHealth(
            queued_events=len(self._queue),
            dropped_events=self._dropped_events,
        )

    def _record(self, draft: EventDraft) -> None:
        if len(self._queue) >= self._max_queue_size:
            self._dropped_events += 1
            if self._on_event_dropped is not None:
                self._on_event_dropped(draft.event_kind)
            return
        self._queue.append(
            Event(
                event_id=str(uuid4()),
                project_key=self._project_key,
                event_kind=draft.event_kind,
                experiment_key=draft.experiment_key,
                definition_revision=draft.definition_revision,
                assignment_id=draft.assignment_id,
                variant_key=draft.variant_key,
                subject_hash=draft.subject_hash,
                linked_subject_hash=draft.linked_subject_hash,
                signal_key=draft.signal_key,
                signal_kind=draft.signal_kind,
                signal_value=draft.signal_value,
                attribution_window_seconds=draft.attribution_window_seconds,
                surface_key=draft.surface_key,
                occurred_at=utc_now(),
                properties=draft.properties,
            ),
        )
