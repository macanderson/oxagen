# tacho.command.fetch

The idle-host control poll (`docs/specs/tacho/spec.md` section 7.4; Mission Control spec Appendix E "control channel; headless"): the collector acknowledges the commands it took and applied, in the §7.4 status vocabulary, and receives the queued ones together with the same control envelope every ingest carries. A host with active sessions never needs this; a host between sessions polls it at the bundle interval.

Every poll first expires this host's commands whose expiry passed before they reached a terminal status, then drains the `queued` rows as `sent`, each carrying its `requested_mode`, `delivery_mode`, `degraded_reason` and the operator's `reason`, which the collector shows at the boundary a pause denies. An acknowledgement lands only on a row that is not terminal: a row Oxagen already cancelled (superseded) or expired keeps what Oxagen recorded.

## Mode

**sync**

## Surface

- API only: `POST /v1/tacho/commands`
- Authentication: enrolled host API key only
- Capability name: `fetch_commands`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `schema` | literal | yes | `tacho.commands.v2` — the collector protocol; a v1 body (no tag, `outcome` from the five-word set) is refused |
| `host_enrollment_id` | string | yes | must equal the key's scope |
| `acknowledgements` | object[] | no | up to 100 of `command_id`, `status`, `detail`, `applied_at_seq`, `session_uuid` |
| `acknowledgements[].status` | enum | yes | `received`, `acknowledged`, `applied`, `failed` — the four a host can assert; `sent` is Oxagen's act and `expired` Oxagen's clock |
| `daemon` | object | no | liveness facts |

`applied` writes `acknowledged_at`, `applied_at` and `applied_at_seq`, the frame the effect landed on; `acknowledged` writes `acknowledged_at`; `received` and `failed` write the status and the detail.

## Output

| Field | Type | Description |
|---|---|---|
| `acknowledged` | integer | acknowledgements that landed on an open row |
| `control` | object | `host_status`, `deny_generation`, `bundle_etag`, `commands[]` — each command carries `id`, `command`, `session_uuid`, `payload`, `requested_mode`, `delivery_mode`, `degraded_reason`, `reason`, `issued_at`, `expires_at` |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
