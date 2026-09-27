# Copyright (c) 2026 Schift

"""Typed setup, collaborator, and client error contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, ClassVar, Final, Protocol

from pydantic import BaseModel, ConfigDict, Field

MAX_BATCH_SIZE: Final = 1000
MAX_QUEUE_SIZE: Final = 100_000

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from schift_ab.contracts import (
        Assignment,
        EventKind,
        ExperimentDefinition,
        ProjectKey,
        SubjectHash,
        WarehouseLogRow,
    )


class ClientErrorReason(StrEnum):
    """Closed set of client contract failures."""

    INVALID_BATCH_SIZE = "invalid_batch_size"
    INVALID_ASSIGNMENT = "invalid_assignment"
    INVALID_DEFINITION = "invalid_definition"
    INVALID_SUBJECT_HASH = "invalid_subject_hash"
    UNKNOWN_VARIANT = "unknown_variant"
    UNKNOWN_SIGNAL = "unknown_signal"
    INVALID_SIGNAL_VALUE = "invalid_signal_value"
    INVALID_PROPERTIES = "invalid_properties"


class AssignmentGateway(Protocol):
    """Caller-owned authenticated path to Schift-AB's sticky allocator."""

    def assign(
        self,
        project_key: ProjectKey,
        experiment: ExperimentDefinition,
        subject_hash: SubjectHash,
    ) -> Assignment:
        """Return a complete sticky assignment for the project and subject."""
        ...


class EventSink(Protocol):
    """Caller-owned authenticated batched writer to warehouse-log."""

    def write_batch(self, rows: Sequence[WarehouseLogRow]) -> None:
        """Persist a bounded group of warehouse-log rows."""
        ...


class ExperimentClientError(Exception):
    """Typed caller or identity errors from the SDK boundary."""

    reason: ClientErrorReason

    def __init__(self, reason: ClientErrorReason) -> None:
        """Create a typed client exception for one known failure reason."""
        super().__init__(reason)
        self.reason = reason


class ClientHealth(BaseModel):
    """Queue health; counters reflect bounded instrumentation buffering."""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True, extra="forbid")
    queued_events: int = Field(ge=0)
    dropped_events: int = Field(ge=0)


class KeyStringModel(BaseModel):
    """Parse project and surface keys supplied by the host application."""

    model_config: ClassVar[ConfigDict] = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
    )
    value: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:-]*$",
    )


@dataclass(frozen=True, slots=True)
class ClientOptions:
    """Immutable SDK wiring; sink credentials remain in the host backend."""

    project_key: str
    assignment_gateway: AssignmentGateway
    event_sink: EventSink
    batch_size: int = 100
    max_queue_size: int = 10_000
    on_event_dropped: Callable[[EventKind], None] | None = None
