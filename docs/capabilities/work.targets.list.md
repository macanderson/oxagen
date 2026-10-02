# list_work_targets

List the workspace's agents with their runtime, enrolled host, tier, and whether each can take a send now, with the reason when not.

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/targets/list`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: a signed-in session or an API key.
- Roles: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`

## Input

None.

## Output

`agents[]`, by name. Retired and deleted agents are left out.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The agent's `agt_…` id |
| `name` | `string` | |
| `harness` | `string` | The harness the agent runs under |
| `runtime` | `{ id, name, tier }` or `null` | The agent's runtime (`rtm_…`) and the tier a send would record. Null when the agent is on no runtime |
| `host` | `{ name, last_poll_at, takes_work_orders }` or `null` | The enrolled host that would receive the work order. Null when none is enrolled |
| `operates` | `boolean` | The person reading operates this agent |
| `busy_with` | `{ id, number }` or `null` | The item this agent's open work order belongs to |
| `can_take` | `boolean` | True when `reason` is null |
| `reason` | reason or `null` | Why the agent cannot take a send now |
| `quiet` | `boolean` | The host has not polled in five minutes |

## Semantics

Each agent is read the way [send_work_order](work.order.send.md) reads its target ([ADR-251](../adr/ADR-251-a-work-order-reaches-its-runtime-on-the-command-channel-and-the-runtime-claims-it.md)), without refusing. The host is the one enrolled for the agent on its runtime that polled last. The reason is the first of these that holds:

- `no_runtime`: the agent is on no runtime.
- `no_host`: no host is enrolled for the agent on its runtime, or every one is revoked.
- `host_outdated`: the host's oxagen build does not take work orders. Update oxagen on that machine.
- `not_operator`: the person reading does not operate the agent. Only the agent's operator can send it work.
- `busy`: the agent is working on another item. An agent holds one open work order at a time.

The tier says where the budget is held: `contained` and `gateway` before each model call, `harness` and `observe` after the run. With no host, the tier reads `contained` when the runtime requires containment and `harness` otherwise.

A quiet host can still take a send. The work order waits until the host polls, so `quiet` blocks nothing. An agent with no host is not quiet: its reason is `no_host`.

This read decides nothing. The send checks all of it again on the server.

A refusal answers with a code:

- `forbidden` (403): the caller holds no role this read takes.
- A body that does not match the input answers 400 before the handler runs.
