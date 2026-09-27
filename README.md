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

## Contract

An experiment declares 2–8 variant keys, one primary reward signal, optional
secondary signals, a surface, and an attribution window for every signal.
Signals are either `choice` or `outcome`, and use `occurrence` or numeric
`value` mode. The SDK records five event kinds: definition, assignment,
exposure, signal, and identity link. `expose()` is separate from `assign()` so a prefetch or
server evaluation is not mistaken for a screen the user actually saw.

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
are stored as events; Schift-AB's allocation service must wait for the
configured attribution window before counting delayed outcomes as rewards.

## Integration

The application supplies the Schift-AB allocation-engine client and a
server-side event sink. `EventSink.writeBatch()` receives rows in the exact
`custom/experiments/events` warehouse schema and writes them to
`POST /v1/data/custom/experiments/events`. The tenant must declare the schema
from [`contracts/experiment-events.json`](contracts/experiment-events.json)
once before the first write. Keep the server credential inside that
sink; never ship a warehouse-log API key to the browser. In a serverless
handler, call `flush()` before returning. In a long-lived process, call it on
a bounded schedule or at the end of a request batch.

The queue is bounded (`maxQueueSize`, default 10,000). Events beyond that
limit are dropped without blocking the host request; read `health()` and alert
on `droppedEvents`. A failed sink write rejects `flush()` and keeps the batch
queued for a later retry.

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
await client.expose(assignment, landing.surface); // after the variant is rendered

// In the signup completion handler, pass the same assignment captured for this visitor.
await client.signal(landing, assignment, 'signup_completed');
await client.flush();
```

The event stream is tenant-scoped at `custom/experiments/events` and accepts
rows through the authenticated data path. Scheduled analysis and email
reports consume these rows separately; this SDK only records and ships the
decision evidence. Using a declared custom schema keeps this repository
independent of the Schift gateway release cycle.

## Current boundary

This commit defines the event contract and SDK seam; it does not yet implement
Schift-AB's allocation service, credentialed warehouse-log HTTP transport,
MCP tools, scheduled aggregation, or email delivery. The next service slice is
the native adaptive allocator and its batch reward updater. Statsig remains a
market reference only. Keep warehouse credentials on the trusted backend.
