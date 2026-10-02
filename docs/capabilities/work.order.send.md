# send_work_order

Send a work item's approved brief to one agent the person operates. The agent's runtime claims the work order before any run starts.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/orders/send`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused.
- Roles: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The work item's `wi_…` id |
| `version` | `int` | The item version the person read, 0 or more |
| `item_revision` | `int` | The item revision the person read, 1 or more |
| `brief_revision` | `int` | The approved brief revision, 1 or more |
| `brief_digest` | `string` | The approved brief's `sha256:` digest |
| `agent_id` | `string` | The agent's `agt_…` id |
| `key` | `string` | `<item>:r<brief revision>:s<send>`, such as `wi_0a1b2c:r2:s1`. Fix it before the first try and send the same key on a retry |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item` | `{ id, state, revision, version }` | The work item after the write. Name `version` on the next decision |
| `repeat` | `boolean` | True when the action was already recorded as asked and nothing changed |
| `order` | `{ id, send, key, delivery }` | The send after the write |
| `command_id` | `string` | The `work_order` command queued to the host (`tcm_…`) |
| `target` | `{ agent_id, runtime_id, host_id, runtime_tier, mandate_id }` | The agent, its runtime, its enrolled host, the runtime's tier (`contained`, `gateway`, `harness`, or `observe`), and its mandate or null |

## Semantics

Oxagen reads the agent's runtime, its enrolled host, its mandate, and the runtime's tier on the server. It opens one work order and queues it to the host as a `work_order` command. The host keeps the command until it claims the order with [claim_work_order](work.order.claim.md), and only then does a run start. The work item adds no authority: the run works under the agent's own mandate.

A retry with the same key returns the same work order and the same command, answers `repeat: true`, and starts no second run. An item has one open send at a time, and an agent has one unreleased send at a time. Oxagen reads the workspace's governance mode from its steering repository. In a regulated workspace, the person who approved the brief cannot send it.

A refusal answers with a code:

- `conflict` (409) carries a `reason`:
  - `stale_version`: the item changed since the version the person read. Read the item again. The same reason answers a key that does not name the next send.
  - `stale_revision`: the item is at another revision than `item_revision`.
  - `stale_brief`: the brief revision or digest is not the approved brief.
  - `not_allowed`: the item is closed or done, another send is still open, the revision has no approved brief, the agent is retired or has no reachable runtime, no machine is enrolled for the agent, the host's oxagen cannot receive work orders yet, or Oxagen could not read the governance mode.
  - `conflict`: the key already names a different send, the agent already has a send out, or another send of the item started at the same time.
- `not_found` (404): the workspace has no such work item, agent, or runtime.
- `forbidden` (403): the caller is not a signed-in person, is an agent run, holds no role the action takes, does not operate the agent, or approved the brief in a regulated workspace.
- A body that does not match the input answers 400 before the handler runs.

See [ADR-250](../adr/ADR-250-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md) for the work actions and [ADR-244](../adr/ADR-244-phase-1-work-records-are-facts-and-the-state-is-reduced-from-them.md) for the work records.
