# dismiss_memories

Dismiss workspace memories, so the curator does not propose their statements again without new evidence, or restore dismissed memories with `restore: true` (#4912). This is the write behind the Memories tab's Dismiss and `oxagen memory dismiss`.

**Surfaces:** api, mcp, cli

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/memories/dismiss`, returns 200
- MCP: `dismiss_memories`
- CLI: `oxagen memory dismiss <ids...> [--restore]`
- App: Steering › Memories, Dismiss memories on the selected rows, and Restore memory in a dismissed memory's drawer
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `memory_ids` | `string[]` | 1 to 200 `mem_…` ids |
| `restore` | `boolean` | Default false. True brings dismissed memories back |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `changed` | `string[]` | The memories this call dismissed or restored |
| `skipped[]` | `{ memory_id, state }` | The memories left as they were, with their state, or null when the workspace holds no such memory |
| `rejections` | `int` | Rows a dismissal wrote to `agent.memory_rejections`, or rows a restore removed |

## Semantics

A dismissal moves each waiting or `in_pr` memory to `dismissed` and adds its statement hash to `agent.memory_rejections`. A hash already there takes the new time and keeps the memory PR that rejected it. The curator then proposes the statement again only after memories from 2 distinct runs repeat it. A memory an open memory PR cites stays dismissed when that PR settles.

A restore moves each dismissed memory back: to `in_pr` when its open memory PR still cites it, else to `waiting`. It removes each statement hash a dismissal wrote, once no other dismissed memory holds that statement. A hash a memory PR rejected stays. Both run in one transaction ([ADR-248](../adr/ADR-248-memories-keep-their-rows-and-rank-by-use.md)).
