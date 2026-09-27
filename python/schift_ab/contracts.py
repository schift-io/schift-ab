# Copyright (c) 2026 Schift

"""Validated SDK and warehouse-log contracts for Schift-AB."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, ClassVar, Final, Literal, NewType, TypedDict

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    model_validator,
)


def _to_camel(value: str) -> str:
    """Use the TypeScript JSON names while retaining Python snake_case fields."""
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


ExperimentKey = NewType("ExperimentKey", str)
ProjectKey = NewType("ProjectKey", str)
SubjectHash = NewType("SubjectHash", str)
VariantKey = NewType("VariantKey", str)
SignalKey = NewType("SignalKey", str)
EventKind = Literal["definition", "assignment", "exposure", "signal", "identity_link"]

_KEY_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]*$")
_HASH_PATTERN = re.compile(r"^[a-zA-Z0-9:_-]+$")
MIN_HASH_LENGTH: Final = 16
MAX_HASH_LENGTH: Final = 256

KeyString = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128, pattern=_KEY_PATTERN.pattern),
]
HashString = Annotated[
    str,
    StringConstraints(
        min_length=MIN_HASH_LENGTH,
        max_length=MAX_HASH_LENGTH,
        pattern=_HASH_PATTERN.pattern,
    ),
]
ExperimentKeyField = Annotated[
    ExperimentKey,
    StringConstraints(min_length=1, max_length=128, pattern=_KEY_PATTERN.pattern),
]
ProjectKeyField = Annotated[
    ProjectKey,
    StringConstraints(min_length=1, max_length=128, pattern=_KEY_PATTERN.pattern),
]
VariantKeyField = Annotated[
    VariantKey,
    StringConstraints(min_length=1, max_length=128, pattern=_KEY_PATTERN.pattern),
]
SignalKeyField = Annotated[
    SignalKey,
    StringConstraints(min_length=1, max_length=128, pattern=_KEY_PATTERN.pattern),
]
SubjectHashField = Annotated[
    SubjectHash,
    StringConstraints(
        min_length=MIN_HASH_LENGTH,
        max_length=MAX_HASH_LENGTH,
        pattern=_HASH_PATTERN.pattern,
    ),
]


class FrozenModel(BaseModel):
    """Base model for parsed, immutable boundary data."""

    model_config: ClassVar[ConfigDict] = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        allow_inf_nan=False,
        populate_by_name=True,
        alias_generator=_to_camel,
    )


class IdentityContractError(Exception):
    """Raised when an identifier is not an opaque pseudonymous subject key."""

    def __init__(self) -> None:
        """Describe the rejected pseudonymous identifier shape."""
        super().__init__("subject hash must be an opaque, versioned pseudonym")


class DefinitionErrorReason(StrEnum):
    """Closed set of invalid experiment definition causes."""

    DUPLICATE_VARIANT_KEYS = "duplicate_variant_keys"
    DUPLICATE_SIGNAL_KEYS = "duplicate_signal_keys"
    UNSUPPORTED_REWARD_MODE = "unsupported_reward_mode"


class DefinitionContractError(ValueError):
    """Typed definition invariant failure surfaced through Pydantic parsing."""

    reason: DefinitionErrorReason

    def __init__(self, reason: DefinitionErrorReason) -> None:
        """Identify which invariant failed."""
        super().__init__(reason)
        self.reason = reason


class VariantDefinition(FrozenModel):
    """A user-visible alternative controlled by an experiment."""

    key: VariantKeyField
    label: str = Field(min_length=1, max_length=120)


class SignalDefinition(FrozenModel):
    """One behavior signal and its reward/attribution interpretation."""

    key: SignalKeyField
    kind: Literal["choice", "outcome"]
    mode: Literal["occurrence", "value"]
    attribution_window_seconds: int = Field(ge=0, le=2_592_000)


class ExperimentDefinition(FrozenModel):
    """Versioned experiment definition shared with the TypeScript SDK."""

    key: ExperimentKeyField
    revision: int = Field(ge=1)
    hypothesis: str = Field(min_length=1, max_length=1000)
    surface: KeyString
    variants: tuple[VariantDefinition, ...] = Field(min_length=2, max_length=8)
    reward: SignalDefinition
    secondary_signals: tuple[SignalDefinition, ...] = Field(default=(), max_length=16)

    @model_validator(mode="after")
    def keys_are_unique(self) -> ExperimentDefinition:
        """Reject ambiguous arm or signal keys before they reach the allocator."""
        variant_keys = [variant.key for variant in self.variants]
        signal_keys = [
            self.reward.key,
            *(signal.key for signal in self.secondary_signals),
        ]
        if len(set(variant_keys)) != len(variant_keys):
            raise DefinitionContractError(DefinitionErrorReason.DUPLICATE_VARIANT_KEYS)
        if len(set(signal_keys)) != len(signal_keys):
            raise DefinitionContractError(DefinitionErrorReason.DUPLICATE_SIGNAL_KEYS)
        match self.reward.mode:
            case "occurrence":
                pass
            case "value":
                raise DefinitionContractError(
                    DefinitionErrorReason.UNSUPPORTED_REWARD_MODE,
                )
        return self


class Assignment(FrozenModel):
    """Sticky assignment returned by the Schift-owned allocation service."""

    assignment_id: KeyString
    project_key: ProjectKeyField
    experiment_key: ExperimentKeyField
    definition_revision: int = Field(ge=1)
    variant_key: VariantKeyField
    subject_hash: SubjectHashField


class Event(FrozenModel):
    """Normalized fact emitted to the experiment warehouse stream."""

    schema_version: Literal["schift.experiment.event.v1"] = Field(
        default="schift.experiment.event.v1",
        alias="schema",
    )
    event_id: KeyString
    project_key: KeyString
    event_kind: EventKind
    experiment_key: ExperimentKeyField | None = None
    definition_revision: int | None = Field(default=None, ge=1)
    assignment_id: KeyString | None = None
    variant_key: VariantKeyField | None = None
    subject_hash: SubjectHashField | None = None
    linked_subject_hash: SubjectHashField | None = None
    signal_key: SignalKeyField | None = None
    signal_kind: Literal["choice", "outcome"] | None = None
    signal_value: float | None = None
    attribution_window_seconds: int | None = Field(default=None, ge=0, le=2_592_000)
    surface_key: KeyString | None = None
    occurred_at: datetime
    properties: JsonValue | None = None


class WarehouseLogRow(TypedDict):
    """Row shape written to ``custom/experiments/events``."""

    event_id: str
    occurred_at: str
    project_key: str
    event_kind: EventKind
    experiment_key: str | None
    definition_revision: int | None
    assignment_id: str | None
    variant_key: str | None
    subject_hash: str | None
    linked_subject_hash: str | None
    signal_key: str | None
    signal_kind: str | None
    signal_value: float | None
    attribution_window_seconds: int | None
    surface_key: str | None
    properties_json: str | None


def parse_experiment(raw: dict[str, JsonValue]) -> ExperimentDefinition:
    """Parse caller configuration once into the immutable experiment contract."""
    return ExperimentDefinition.model_validate_json(json.dumps(raw))


def subject_hash(value: str) -> SubjectHash:
    """Parse an opaque tenant-scoped pseudonym after trusted HMAC generation."""
    if (
        len(value) < MIN_HASH_LENGTH
        or len(value) > MAX_HASH_LENGTH
        or _HASH_PATTERN.fullmatch(value) is None
    ):
        raise IdentityContractError
    return SubjectHash(value)


def parse_assignment(raw: JsonValue) -> Assignment:
    """Parse a complete allocator response at the authenticated service boundary."""
    return Assignment.model_validate_json(json.dumps(raw))


def utc_now() -> datetime:
    """Return an aware UTC timestamp for a newly recorded event."""
    return datetime.now(UTC)
