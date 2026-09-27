# Schift-AB Python SDK

The Python package is a thin server-side client for Schift-owned assignment and
warehouse-log contracts. It does not implement a second allocator or connect to
Statsig. Applications provide an `AssignmentGateway` for sticky assignments
and an `EventSink` for batched warehouse rows.

## Install

```sh
cd python
uv sync
```

## Define and run an experiment

Definitions accept the shared TypeScript camelCase JSON names. Python callers
may also use snake_case when constructing the frozen Pydantic models.

```python
import os
import hmac
from collections.abc import Sequence
from hashlib import sha256

from schift_ab import (
    Assignment,
    ClientOptions,
    ExperimentClient,
    ExperimentDefinition,
    ProjectKey,
    SubjectHash,
    WarehouseLogRow,
    parse_experiment,
    subject_hash,
)

definition = parse_experiment({
    "key": "landing.hero",
    "revision": 1,
    "hypothesis": "A shorter headline increases completed signups",
    "surface": "landing",
    "variants": [
        {"key": "control", "label": "Current headline"},
        {"key": "short", "label": "Short headline"},
    ],
    "reward": {
        "key": "signup_completed",
        "kind": "outcome",
        "mode": "occurrence",
        "attributionWindowSeconds": 86400,
    },
    "secondarySignals": [{
        "key": "signup_cta_clicked",
        "kind": "choice",
        "mode": "occurrence",
        "attributionWindowSeconds": 3600,
    }],
})

# Generate tenant-scoped pseudonyms in a trusted backend. Never send raw IDs
# or the HMAC secret to a browser or third-party telemetry service.
def pseudonym(secret: bytes, tenant: str, raw_id: str) -> str:
    message = f"{tenant}:{raw_id}".encode()
    digest = hmac.new(secret, message, sha256).hexdigest()
    return f"h1:{digest}"

secret = os.environ["SCHIFT_AB_HMAC_KEY"].encode("utf-8")
subject = subject_hash(pseudonym(secret, "tenant-a", "visitor-123"))

class Allocator:
    def assign(
        self,
        project_key: ProjectKey,
        experiment: ExperimentDefinition,
        subject_hash: SubjectHash,
    ) -> Assignment:
        # Call Schift-AB's assignment endpoint and parse its response here.
        return Assignment(
            assignment_id="asg_1234567890",
            project_key=project_key,
            experiment_key=experiment.key,
            definition_revision=experiment.revision,
            variant_key="control",
            subject_hash=subject_hash,
        )

class WarehouseSink:
    def write_batch(self, rows: Sequence[WarehouseLogRow]) -> None:
        # Forward rows to POST /v1/data/custom/experiments/events.
        ...

client = ExperimentClient(ClientOptions(
    project_key="schift-site",
    assignment_gateway=Allocator(),
    event_sink=WarehouseSink(),
    on_event_dropped=lambda kind: print(f"experiment event dropped: {kind}"),
))
client.register(definition)
assignment = client.assign(definition, subject)

# Call after the assigned variant was actually rendered.
client.expose(definition, assignment)
# Record the declared goal after its real application event occurs.
client.signal(definition, assignment, "signup_completed")
client.flush()
```

The allocator must keep a subject's assignment sticky for an experiment revision
and return a variant declared by that definition with a persistent
`assignment_id`. The client queues assignment,
actual exposure, declared signal, identity-link, and definition facts. Its queue
is bounded; `health()` exposes queued and dropped event counts. `flush()` sends
rows in bounded batches and retains a batch if the sink raises so the host can
retry it. The sink row uses the shared snake_case warehouse schema, including
`subject_hash` and `linked_subject_hash` for later identity joins.

`reward.mode` must be `occurrence` for the v1 adaptive allocator. Value signals
can be recorded as secondary signals, but they are not allocator rewards in
this version. A reward is attributed to an exposure by the definition's
`attributionWindowSeconds`.

The event queue is capped by `max_queue_size`; pass `on_event_dropped` to
surface overflow in the application's own telemetry and alerting.

Treat `Assignment` as server-authored state. Do not accept a client-created
assignment object as proof of allocation. Browser exposure and choice events
should pass through the application's authenticated sink, which can validate
the assignment ID; batch aggregation ignores rewards without a matching actual
exposure.

## Local checks

```sh
uv run --with basedpyright basedpyright schift_ab
uv run --with ruff ruff check schift_ab
uv run --with ruff ruff format --check schift_ab
```
