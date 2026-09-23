# ingest_tacho_events

Ingest a batch of hash-chained `tacho/1.0` events from an enrolled host (`docs/specs/tacho/spec.md` section 3.1; column contract in `docs/specs/tacho/data-model.md`). Machine-to-machine only. Tenant scope comes exclusively from the API key; the key must carry the server-owned `tacho_host_v1` scope naming a live host in this tenant, and every event must name that host, or the batch is denied in full.

Every event's hash is recomputed and every chain link checked, within the batch and against the session's recorded head. An event re-sent below the recorded head is compared with the frame already stored at its seq: the same hash is not written again, a different hash is refused and answered in `chain_breaks`, and a seq with no stored frame is written, since that is the retry of an append that failed. The control envelope, which drains the host's queued commands, is built only after the batch's events are stored. Telemetry is fail-open: a chain break never rejects a batch; it is recorded on the session row, stamped on every affected event as `chain_verified = false`, and answered in `chain_breaks`. Bodies carry digests only; the schema cannot represent prompt, tool, or response bytes.

What lands: every event in ClickHouse `tacho_events` (one row per event, every scalar as a typed column); the session row, per-model usage, files touched, and commands run in Postgres; the host's liveness. The response is also the control channel: it carries the host's status, the current deny generations, the bundle etag, and any pending commands, so an active host needs no separate poll. Up to 200 events per batch, each body capped at 1 MiB before encoding; the request itself is capped at 4 MiB on the wire (`TACHO_MAX_REQUEST_BYTES`), measured as JSON including base64-encoded bodies.

A `proof.observed` event is a witness verdict on the worker's run (Mission Control spec §8.5, ADR-064). Its body must hold to `proofObservedBodySchema` (`@oxagen/run-evidence`): a malformed body, or a `flipped` verdict whose results show no flip, is still recorded as a frame of its chain; only its verdict row is skipped, and `proof_rejections` names the event and the reason. Each fresh `proof.observed` event writes one `evidence.verdicts` row under the run it is part of, the root session its `root_session_uuid` names, whichever session's chain carried it (its attempt number in observed order per run and witness), and the `evidence.witnesses` row on first sight. The batch is refused with `conflict` when an event names a known witness with another oracle, command digest or held-out flag (`witness_identity_changed`); when its root session is not recorded in the workspace (`root_session_unrecorded`); or when its `witness_run_id` names the run itself, names no root run in the workspace, names a run that carries verdicts of its own or one another run's verdict already names, or the run it reports on is itself a witness run (`witness_run_invalid`). A verdict reaching a root session sealed before it asks the rollup to rebuild the run's `cost.run_totals` row, which carries the run's aggregated verdict, and each witness run a new verdict names is rebuilt as well.

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
| `proof_rejections` | object[] | optional; `event_id_idem`, `reason` for each `proof.observed` body the schema refused |
| `control` | object | `host_status`, `deny_generation`, `bundle_etag`, `commands[]` |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.

When the cached retention mandate is unproven, an event with a retained body waits with its session suffix. This preserves the dense chain and keeps the body in the same ingest request as its event. Other sessions continue to drain, even if the held session fills a batch. The hold ends 24 hours after the event timestamp, which survives a daemon restart. An invalid or future timestamp releases immediately. Release sends the event body-missing and logs the reason and count. A proven narrowing still drops the body and ships the event.
