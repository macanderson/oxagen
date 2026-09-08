# tacho.command.fetch

The idle-host control poll: acknowledge the outcomes of commands the collector applied, and receive pending ones together with the same control envelope every ingest carries. A host with active sessions never needs this; a host between sessions polls it at the bundle interval.

## Mode

**sync**

## Surface

- API only: `POST /v1/tacho/commands`
- Authentication: enrolled host API key only
- Capability name: `fetch_tacho_commands`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `host_enrollment_id` | string | yes | must equal the key's scope |
| `acknowledgements` | object[] | no | `command_id`, `outcome` (not `pending`), `detail`, `applied_at_seq`, `session_uuid` |
| `daemon` | object | no | liveness facts |

## Output

| Field | Type | Description |
|---|---|---|
| `acknowledged` | integer | commands whose outcome was recorded |
| `control` | object | `host_status`, `deny_generation`, `bundle_etag`, `commands[]` |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
