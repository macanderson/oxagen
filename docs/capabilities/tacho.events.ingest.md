# tacho.events.ingest

Ingest a batch of hash-chained `tacho/1.0` events from an enrolled host (`docs/specs/tacho/spec.md` section 3.1; column contract in `docs/specs/tacho/data-model.md`). Machine-to-machine only. Tenant scope comes exclusively from the API key; the key must carry the server-owned `tacho_host_v1` scope naming a live host in this tenant, and every event must name that host, or the batch is denied in full.

Every event's hash is recomputed and every chain link checked, within the batch and against the session's recorded head. Telemetry is fail-open: a chain break never rejects a batch; it is recorded on the session row, stamped on every affected event as `chain_verified = false`, and answered in `chain_breaks`. Bodies carry digests only; the schema cannot represent prompt, tool, or response bytes.

What lands: every event in ClickHouse `tacho_events` (one row per event, every scalar as a typed column); the session row, per-model usage, files touched, and commands run in Postgres; the host's liveness. The response is also the control channel: it carries the host's status, the current deny generations, the bundle etag, and any pending commands, so an active host needs no separate poll. Body limit 1 MiB, up to 200 events per batch.

## Mode

**sync**

## Surface

- API only: `POST /v1/tacho/events`
- Authentication: enrolled host API key only
- Capability name: `ingest_tacho_events`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `schema` | `tacho.batch.v1` | yes | |
| `host_enrollment_id` | string | yes | must equal the key's scope |
| `events` | object[] | yes | 1-200 sealed `tacho/1.0` events, strict |
| `daemon` | object | no | `version`, `uptime_s`, `spool_depth`, `spool_oldest_at`, `hooks_ok`, `otel_ok`, `bundle_etag` |

## Output

| Field | Type | Description |
|---|---|---|
| `accepted` | integer | 1-200 |
| `event_ids` | string[] | idempotency ids (`evt_<sha256>`), request order |
| `chain_breaks` | object[] | `session_uuid`, `at_seq`, `reason` |
| `control` | object | `host_status`, `deny_generation`, `bundle_etag`, `commands[]` |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
