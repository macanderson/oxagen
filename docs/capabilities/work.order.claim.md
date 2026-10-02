# claim_work_order

Claim a work order for the calling enrolled host before it starts a run, and read the first prompt the run starts with. The host calls this after it receives a `work_order` command.

**Surfaces:** api

## Surface

- API: `POST /v1/tacho/work-orders/claim`, returns 200
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

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `repeat` | `boolean` | True when this host had already claimed the order. Nothing new was recorded |
| `work_order` | `{ id, key, send, item_id, item_number, brief_revision, repository, agent_id, harness }` | The order, its work item and that item's number (such as `acme/platform#612`), the brief revision, the repository as owner/name, and the agent with its harness |
| `prompt` | `string` | The first prompt of the run: the approved brief, then the issue text fenced as data |

## Semantics

The claim is the handshake before anything starts. It binds the order to this host, and its answer carries the run's first prompt. The host must start no run for an order it has not claimed.

A host that claims again, after a lost answer, gets the same claim and the same prompt back and records nothing new. Once a run is linked to the order, a repeat claim is refused, because a run already started. The order's `work_order` command names the host it was sent to, so another host's claim is refused, even on the same runtime.

The host's API key carries its org and workspace. The handler checks that the key belongs to the enrollment the call names and that the host is neither revoked nor expired.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `conflict`: another host already claimed this order. This host must not start it.
  - `not_allowed`: the send has ended (withdrawn, stopped, returned, or rejected), or a run already started for it. This host must not start it.
- `not_found` (404): the workspace has no such work order, or the order's brief is missing.
- `forbidden` (403): the key is not this enrollment's host key, the host is unknown, revoked, or expired, the key's creator is no longer an org Owner or Admin, or the order was sent to another host, runtime, or agent.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-250](../adr/ADR-250-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions. [reject_work_order](work.order.reject.md) refuses an order the host cannot start.
