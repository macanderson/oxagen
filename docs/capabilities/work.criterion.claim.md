# claim_work_criterion

Claim, as the agent working a send, that one criterion of the brief is met on the pull request's head commit. The claim shows on the work item beside the criterion. A person still decides.

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/orders/criteria/claim`, returns 200
- MCP: `claim_work_criterion`
- Not on the CLI or agent surface.
- Authentication: the run linked to the send, or the API key of the enrolled host that claimed the send. A signed-in person and any other API key are refused before anything is read.
- Roles: the host key's creator must still be an org Owner or Admin, as for [claim_work_order](work.order.claim.md)
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The `wi_…` id |
| `work_order_id` | `string` | The send's `wo_…` id |
| `criterion_id` | `string` | A criterion of the brief the send went out with, such as `c1` |
| `head_sha` | `string` | The pull request's head commit, 40 lowercase hex characters |
| `text` | `string` | How the agent met the criterion, 1 to 2000 characters |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the claim. A claim leaves its state as it was |
| `repeat` | `boolean` | True when the same claim was already recorded on this head. Nothing new was recorded |
| `order` | `{ id, send, key, delivery }` | The send |
| `claim` | `{ criterion_id, head_sha, run_id }` | The claim, and the run it is filed as: the run linked to the send |

## Semantics

A claim is the agent's word (ADR-244). Oxagen records it as a `criterion_claimed` fact from the agent, and the work item shows it beside the criterion with the head commit it names. A claim never moves the item's state, and it never accepts anything: a person still ticks every criterion and accepts the head.

Only the agent working the send can claim. Oxagen binds the claim to the run linked to the send. That run is the first run of the claiming host that named the send:

- A call from an agent run counts only when that run is the send's linked run.
- A call with a host key counts only when that host claimed the send and a run is linked. The claim is filed as that run.

The claim has to fit the send as it stands now. The send is open, the work item is still at the revision the send went out on, `head_sha` is the pull request's current head, and `criterion_id` is in the brief the send carries. A new head leaves earlier claims on the old head, and the agent claims again on the new one.

The same claim again, on the same send, criterion, and head, records nothing new and answers `repeat: true`. The first text stands.

A refusal answers with a code:

- `forbidden` (403): a signed-in person or an API key that is not a host key (`reason` `agent_required`), a host key whose host is unknown, revoked, or expired, a key creator who is no longer an org Owner or Admin, a run that is not the send's linked run, or a host that did not claim the send.
- `conflict` (409) carries a `reason`:
  - `not_allowed`: the send is over, or no run is linked to it yet.
  - `stale_revision`: the work item moved to a later revision after the send went out.
  - `stale_head`: Oxagen has not seen a head commit on the pull request yet, or `head_sha` is not the current head.
- `not_found` (404): the workspace has no such work item or send, or the send's brief is missing.
- `invalid_input` (400): the brief the send carries has no such criterion, or the body does not match the input.

See [ADR-251](../adr/ADR-251-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for how a run is linked to a send, and [accept_work_order](work.order.accept.md) for the person's decision.
