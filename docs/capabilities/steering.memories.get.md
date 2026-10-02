# get_workspace_memory

Read one workspace memory in full: its text, where it came from, the runs that used it, and the memory PR that last cited it (#4912). It writes nothing. This is the read behind the Memories tab's drawer and `oxagen memory show`.

**Surfaces:** api, mcp, cli

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/memories/get`, returns 200
- MCP: `get_workspace_memory`
- CLI: `oxagen memory show <id>`
- Authentication: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `memory_id` | `string` | The memory's public id, `mem_…` |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `memory` | memory | The fields [list_workspace_memories](steering.memories.list.md) answers, plus `run`, `evidence`, `applies_to`, `tools`, `retired_at`, and `retired_reason` (`deleted` or `unused`) |
| `uses[]` | `{ run, signal, count, used_at }` | Newest first, at most 100. `signal` is `read`, `harness_count`, or `citation`. `run` is null for a harness's own count |
| `uses_total` | `int` | Every use row the memory holds |
| `memory_pr` | `{ id, number, url, repository, branch, status, opened_at, settled_at }` or null | The memory PR that last cited it |

## Semantics

A memory another workspace holds answers `not_found` with reason `memory_not_found`, the same as one that does not exist.
