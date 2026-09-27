from collections.abc import Sequence

import pytest

from schift_ab import (
    Assignment,
    ClientOptions,
    ExperimentClient,
    ExperimentClientError,
    ExperimentDefinition,
    ProjectKey,
    SubjectHash,
    WarehouseLogRow,
    parse_experiment,
    subject_hash,
)

SUBJECT = subject_hash(f"h1:{'a' * 64}")


def definition() -> ExperimentDefinition:
    return parse_experiment(
        {
            "key": "landing.hero",
            "revision": 1,
            "hypothesis": "Benefit copy increases completed signups.",
            "surface": "landing.home",
            "variants": [
                {"key": "control", "label": "Current"},
                {"key": "benefit", "label": "Benefit"},
            ],
            "reward": {
                "key": "signup_completed",
                "kind": "outcome",
                "mode": "occurrence",
                "attributionWindowSeconds": 3600,
            },
            "secondarySignals": [],
        },
    )


class Allocator:
    def assign(
        self,
        project_key: ProjectKey,
        experiment: ExperimentDefinition,
        subject_hash: SubjectHash,
    ) -> Assignment:
        return Assignment(
            assignment_id="assignment-1",
            project_key=project_key,
            experiment_key=experiment.key,
            definition_revision=experiment.revision,
            variant_key="benefit",
            subject_hash=subject_hash,
        )


class Sink:
    def __init__(self) -> None:
        self.rows: list[WarehouseLogRow] = []

    def write_batch(self, rows: Sequence[WarehouseLogRow]) -> None:
        self.rows.extend(rows)


def test_client_emits_joinable_rows() -> None:
    sink = Sink()
    client = ExperimentClient(
        ClientOptions(
            project_key="site-a",
            assignment_gateway=Allocator(),
            event_sink=sink,
        ),
    )
    experiment = definition()

    client.register(experiment)
    assignment = client.assign(experiment, SUBJECT)
    client.expose(experiment, assignment)
    client.signal(experiment, assignment, "signup_completed")
    client.flush()

    assert [row["event_kind"] for row in sink.rows] == [
        "definition",
        "assignment",
        "exposure",
        "signal",
    ]
    assert sink.rows[-1]["assignment_id"] == "assignment-1"
    assert all(row["project_key"] == "site-a" for row in sink.rows)


def test_client_rejects_assignment_from_another_project() -> None:
    class WrongProjectAllocator(Allocator):
        def assign(
            self,
            project_key: ProjectKey,
            experiment: ExperimentDefinition,
            subject_hash: SubjectHash,
        ) -> Assignment:
            assignment = super().assign(project_key, experiment, subject_hash)
            return assignment.model_copy(update={"project_key": "other"})

    client = ExperimentClient(
        ClientOptions(
            project_key="site-a",
            assignment_gateway=WrongProjectAllocator(),
            event_sink=Sink(),
        ),
    )

    with pytest.raises(ExperimentClientError) as error:
        client.assign(definition(), SUBJECT)

    assert error.value.reason.value == "invalid_assignment"


def test_bounded_queue_reports_drops() -> None:
    dropped: list[str] = []
    sink = Sink()
    client = ExperimentClient(
        ClientOptions(
            project_key="site-a",
            assignment_gateway=Allocator(),
            event_sink=sink,
            batch_size=1,
            max_queue_size=1,
            on_event_dropped=dropped.append,
        ),
    )
    experiment = definition()

    client.register(experiment)
    client.assign(experiment, SUBJECT)

    assert client.health().dropped_events == 1
    assert dropped == ["assignment"]
