# revise_work_triage

Correct a work item's triage suggestion or its outcome, or clear a correction (lane P1-03, #5103).

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/triage/revise`, returns 200
- MCP: `revise_work_triage`
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The `wi_…` id |
| `expected_version` | `int` | The item version the person read. A stale version is refused with 409 `stale_version` |
| `reason` | `string` | Why the person changed it, 1 to 2,000 characters |
| `priority` | `P0` to `P3`, or `null` | Null clears the person's priority |
| `estimate_minutes` | `int` or `null` | 0 to 43,200 agent minutes |
| `labels` | `string[]` or `null` | Up to 50 |
| `claims` | `string[]` or `null` | Predicted path globs, up to 50 |
| `criteria` | `string[]` or `null` | Acceptance criteria, 1 to 50 |
| `outcome` | `triaged`, `needs_info`, `duplicate`, `out_of_scope`, or `null` | Null clears the person's override |
| `duplicate_of` | `string?` | The item this one repeats. Required with the outcome `duplicate`, and refused without it |

A call must change at least one field or the outcome.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | |
| `version` | `int` | The item version after the change |
| `state` | `string` | The item's state |
| `changed` | `string[]` | The fields this call changed or cleared |
| `triage` | object | The suggestion with every correction in force. Each field says whether triage (`oxagen`) or a person set it |
| `standing` | object | The outcome in force, who set it, and the duplicate it names |

## Semantics

A field correction is one `work.triage_corrections` row per field, against the decision the person read. It stays in force through every later triage run, so a new decision after a source change never undoes it, until a person clears it with `null`. A priority correction also sets the item's planning priority. The outcome is a `triage_overridden` fact (ADR-244), which the item's state follows: `duplicate` and `out_of_scope` hold the item, and `needs_info` waits for an answer. Triage can be revised only while the item is new, held, triaged, needs_info, or changed. A correction grants no authority and writes nothing back to the source.

Errors: 400 for a call that changes nothing or names a duplicate wrongly, 404 for an item or duplicate the workspace does not hold, 409 for a stale version, an item past triage, or a field correction before triage suggested anything.
