# Schift-AB

An independently versioned Schift experiment SDK and decision service contract.
The repository/package name is `schift-ab`; the user-facing product name can be
**Schift Experiments**.

TypeScript SDK contract for assigning variants, recording real exposures,
forwarding declared choice/outcome signals to Schift-AB's allocation engine,
and buffering evidence for warehouse-log. `AllocationEngine` is a Schift-owned
service contract: it supplies assignments, observes real exposures, and
receives reward signals. Statsig is a research benchmark, not a runtime
dependency or integration target. `EventSink` sends validated rows to Schift's
event ingestion path.

## Install

TypeScript:

```sh
npm install @schift-io/schift-ab
```

Python:

```sh
pip install schift-ab
```

Both packages are server-side SDKs. Keep assignment credentials, pseudonym
secrets, and warehouse-log credentials in the trusted application backend.

## Contract

An experiment declares 2–8 variant keys, one primary reward signal, optional
secondary signals, a surface, and an attribution window for every signal.
Signals are either `choice` or `outcome`, and use `occurrence` or numeric
`value` mode. The SDK records five event kinds: definition, assignment,
exposure, signal, and identity link. `expose()` is separate from `assign()` so a prefetch or
server evaluation is not mistaken for a screen the user actually saw.

The v1 adaptive reward must be binary `occurrence` (for example, a click or
completed signup). Numeric signals such as dwell time remain reportable as
secondary signals; the v1 allocator does not assume longer is always better.
Request-time allocation uses Thompson sampling over Beta(1 + rewards,
1 + mature non-rewards) posteriors. Assignments are sticky for a subject and
definition revision, so later visits do not reshuffle an already assigned
person. New subjects use the latest published posterior snapshot.

Repository keys include `project_key`; experiment names and subject hashes are
project-local and must never collide across tenants. Sticky assignment writes
use atomic insert-if-absent to handle concurrent first visits.

The batch worker groups actual exposures by `assignment_id`, waits through the
reward's attribution window, joins matching signal events, and emits a full
cumulative reward aggregate for every variant. Missing outcomes count as
non-rewards only after that window matures. Applying a full aggregate replaces
posterior counts instead of incrementing them, so retrying the same batch does
not double-count. A monotonically increasing `batchSequence`, nondecreasing
cumulative counts, and compare-and-set snapshot store reject duplicate,
regressing, stale, or concurrent publication. If the allocation
snapshot is older than six hours, `AdaptiveBandit.assign()` fails with
`snapshot_stale`; the host should serve its explicit fallback and alert.

Every event has a random `eventId` for idempotent ingestion and event time.
Assignment, exposure, and signal events also carry a stable `assignmentId` and
`subjectHash` so delayed outcomes join back to the assigned variant. Definition
events are project-level; identity-link events join two pseudonymous hashes.
Do not pass raw account IDs, email addresses,
phone numbers, or secrets. The application must provide tenant-scoped stable
pseudonyms, preferably versioned tenant-keyed HMACs. For anonymous visitors use
a random persistent anonymous key and have the trusted backend derive its hash;
after login emit `linkIdentity` to
connect that pseudonym to the backend's user hash. Never calculate a plain
SHA-256 of a low-entropy raw user ID in browser code.

`signal()` accepts only keys declared in the experiment. The primary reward is
the sole automatic-allocation objective; secondary signals are for reporting
and guardrails. `signalValue` is required for `value` mode. Long-delay outcomes
are stored as events; the batch updater counts them only after the configured
attribution window closes.

Treat `Assignment` as server-authored state. Do not accept a client-created
assignment object as proof of a real allocation. Browser exposure/click events
should pass through the application's authenticated event route, which can
check the assignment ID before forwarding them. The batch updater ignores
signals without a matching, actually rendered exposure.

## Integration

The application supplies the Schift-AB allocation-engine client and a
server-side event sink. `EventSink.writeBatch()` receives rows in the exact
`custom/experiments/events` warehouse schema and writes them to
`POST /v1/data/custom/experiments/events`. The tenant must declare the schema
from [`contracts/experiment-events.json`](contracts/experiment-events.json)
once before the first write. Keep the server credential inside that
sink; never ship a warehouse-log API key to the browser. Browser-side exposure
and choice events should be forwarded through the host application's
server-side sink. In a serverless
handler, call `flush()` before returning. In a long-lived process, call it on
a bounded schedule or at the end of a request batch.

The queue is bounded (`maxQueueSize`, default 10,000). Events beyond that
limit are dropped without blocking the host request; supply `onEventDropped`
and alert on `health().droppedEvents`. A failed sink write rejects `flush()`
and keeps the batch queued for a later retry.

```ts
import { ExperimentClient, defineExperiment } from '@schift-io/schift-ab';

const landing = defineExperiment({
  key: 'landing.hero',
  revision: 1,
  hypothesis: 'A concrete benefit headline increases completed signups.',
  surface: 'landing.home',
  variants: [
    { key: 'control', label: 'Current headline' },
    { key: 'benefit_copy', label: 'Benefit-led headline' },
  ],
  reward: { key: 'signup_completed', kind: 'outcome', mode: 'occurrence', attributionWindowSeconds: 86400 },
  secondarySignals: [
    { key: 'signup_cta_clicked', kind: 'choice', mode: 'occurrence', attributionWindowSeconds: 3600 },
  ],
});

const client = new ExperimentClient({ projectKey, allocator, sink });
client.register(landing); // once for each deliberate definition revision
const assignment = await client.assign(landing, subjectHash);
const page = renderLandingVariant(assignment.variantKey);
client.expose(landing, assignment); // after the variant is rendered

// In the signup completion handler, pass the same assignment captured for this visitor.
client.signal(landing, assignment, 'signup_completed');
await client.flush();
```

The event stream is tenant-scoped at `custom/experiments/events` and accepts
rows through the authenticated data path. Scheduled analysis and email
reports consume these rows separately; this SDK only records and ships the
decision evidence. Using a declared custom schema keeps this repository
independent of the Schift gateway release cycle.

## Current boundary

The native Thompson allocator and cumulative batch reward updater are
implemented as library logic. This repository does not yet include a durable
allocation/assignment store, HTTP API, scheduled warehouse scan, MCP tools, or
email delivery. Those adapters are the remaining service work. Statsig remains
a market reference only. Keep warehouse credentials on the trusted backend.

The matching Python SDK lives in [`python/`](python/README.md). Both SDKs call
the same Schift allocation API contract and write the same warehouse event
rows; the adaptive posterior and batch updater are implemented in this
TypeScript service package.
