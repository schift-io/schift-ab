# Copyright (c) 2026 Schift

"""Event drafts and warehouse-log row serialization."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from schift_ab.contracts import (
        Event,
        EventKind,
        ExperimentKeyField,
        JsonValue,
        SignalKeyField,
        SubjectHash,
        VariantKeyField,
        WarehouseLogRow,
    )


@dataclass(frozen=True, slots=True)
class EventDraft:
    """Domain event fields before the SDK adds event identity and timestamp."""

    event_kind: EventKind
    experiment_key: ExperimentKeyField | None = None
    definition_revision: int | None = None
    assignment_id: str | None = None
    variant_key: VariantKeyField | None = None
    subject_hash: SubjectHash | None = None
    linked_subject_hash: SubjectHash | None = None
    signal_key: SignalKeyField | None = None
    signal_kind: Literal["choice", "outcome"] | None = None
    signal_value: float | None = None
    attribution_window_seconds: int | None = None
    surface_key: str | None = None
    properties: JsonValue | None = None


def to_warehouse_row(event: Event) -> WarehouseLogRow:
    """Serialize one validated event into the shared snake_case sink row."""
    properties_json = (
        None
        if event.properties is None
        else json.dumps(event.properties, separators=(",", ":"), allow_nan=False)
    )
    return {
        "event_id": event.event_id,
        "occurred_at": event.occurred_at.isoformat().replace("+00:00", "Z"),
        "project_key": event.project_key,
        "event_kind": event.event_kind,
        "experiment_key": event.experiment_key,
        "definition_revision": event.definition_revision,
        "assignment_id": event.assignment_id,
        "variant_key": event.variant_key,
        "subject_hash": event.subject_hash,
        "linked_subject_hash": event.linked_subject_hash,
        "signal_key": event.signal_key,
        "signal_kind": event.signal_kind,
        "signal_value": event.signal_value,
        "attribution_window_seconds": event.attribution_window_seconds,
        "surface_key": event.surface_key,
        "properties_json": properties_json,
    }
