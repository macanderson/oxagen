# reject_work_order

Refuse a work order the calling enrolled host cannot start, with the reason, such as a harness that is signed out. The send ends and the work item can be sent again.

**Surfaces:** api

## Surface

- API: `POST /v1/tacho/work-orders/reject`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: The enrolled host's API key, for the enrollment the call names.
- Roles: the key's creator must still be an org Owner or Admin
- Body: at most 16 KiB, sent as `application/json`
- Rate limit: 30 calls a minute per host, shared by the claim and the rejection
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `host_enrollment_id` | `string` | The calling host's enrollment, `tch_` and 22 lowercase letters or digits |
| `work_order_id` | `string` | The send's `wo_…` id |
| `reason` | `string` | 1 to 512 characters after trimming |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `repeat` | `boolean` | True when the order was already rejected. Nothing new was recorded |

## Semantics

The send ends as `rejected`, the agent is free again, and the work item goes back to `ready`. A person can then send it again or close it. A host can reject an order it has not linked a run to. Once a run is linked, the run's own end is the record.

The host's API key carries its org and workspace. The handler checks that the key belongs to the enrollment the call names and that the host is neither revoked nor expired.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `not_allowed`: a run is linked to this order. Its end is the record, not a rejection.
  - `conflict`: another host claimed this order.
- `not_found` (404): the workspace has no such work order.
- `forbidden` (403): the key is not this enrollment's host key, the host is unknown, revoked, or expired, the key's creator is no longer an org Owner or Admin, or the order went to another runtime or agent.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-251](../adr/ADR-251-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions. [claim_work_order](work.order.claim.md) is the call before a run starts.
