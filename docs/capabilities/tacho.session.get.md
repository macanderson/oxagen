# tacho.session.get

One session's flight-recorder index (`docs/specs/tacho/data-model.md` section 3): the full session row (identity, harness, place, inventory, totals, policy counters, chain state), its subagent chains, per-model usage, files touched, commands run, incidents, and the checkpoint count. The events themselves live in ClickHouse `tacho_events` keyed by `session_uuid`.

## Mode

**sync**

## Surface

- API only: `POST /v1/:org_slug/:workspace_slug/tacho/sessions/get`
- Authentication: session (org Owner, Admin, or Member)
- Capability name: `get_tacho_session`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `sessionUuid` | uuid | yes | |

## Output

| Field | Type | Description |
|---|---|---|
| `session` | object | the full session projection |
| `children` | object[] | subagent session summaries |
| `models` | object[] | per-model usage |
| `files` | object[] | paths touched with counts and seq range |
| `commands` | object[] | shell commands with decision and rule |
| `incidents` | object[] | |
| `checkpointCount` | integer | |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
