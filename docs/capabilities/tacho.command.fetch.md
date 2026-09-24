# fetch_commands

The idle-host control poll (`docs/specs/tacho/spec.md` section 7.4; Mission Control spec Appendix E "control channel; headless"): the collector acknowledges the commands it took and applied, in the §7.4 status vocabulary, and receives the queued ones together with the same control envelope every ingest carries. A host with active sessions never needs this; a host between sessions polls it at the bundle interval.

Every poll first expires this host's `queued` commands whose expiry passed before a poll drained them, then drains the remaining `queued` rows as `sent`, each carrying its `requested_mode`, `delivery_mode`, `degraded_reason` and the operator's `reason`, which the collector shows at the boundary a pause denies. A `sent` row with no acknowledgement 60 seconds after it left is offered again on the next poll, since its response may never have reached the host; the collector applies a command once and answers a repeat with the acknowledgement it already gave. A row that left on the wire is otherwise the host's: the collector checks the deadline at receipt and again at the boundary that would inject a steer and acknowledges `expired` when the deadline passed with no boundary reached, and its acknowledgement lands even when it arrives after the clock passed. The sweep settles a `sent` row as `expired` only once an hour has passed since both its expiry and its last delivery with no acknowledgement, so a lost answer does not read as a delivery in flight for ever; a row the host acknowledged in any way is left for the host to settle. An acknowledgement lands only on a row that is not terminal: a row Oxagen already cancelled (superseded) or expired while `queued` keeps what Oxagen recorded.

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
| `acknowledgements[].status` | enum | yes | `received`, `acknowledged`, `applied`, `expired`, `failed` — the five a host can assert; `sent` is Oxagen's act |
| `daemon` | object | no | liveness facts |

`applied` writes `acknowledged_at`, `applied_at` and `applied_at_seq`, the frame the effect landed on; `acknowledged` writes `acknowledged_at`; `received` and `failed` write the status and the detail.

## Output

| Field | Type | Description |
|---|---|---|
| `acknowledged` | integer | acknowledgements that landed on an open row |
| `control` | object | `host_status`, `deny_generation`, `bundle_etag`, `commands[]` — each command carries `id`, `command`, `session_uuid`, `payload`, `requested_mode`, `delivery_mode`, `degraded_reason`, `reason`, `issued_at`, `expires_at` |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
