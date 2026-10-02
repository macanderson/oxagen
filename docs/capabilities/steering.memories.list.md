# list_workspace_memories

List the workspace's memories, the lessons agents wrote in their harnesses' own memory stores, ranked by how often runs used them (#4912). It writes nothing. This is the read behind the Memories tab on the Steering page and `oxagen memory list`.

**Surfaces:** api, mcp, cli

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/memories/list`, returns 200
- MCP: `list_workspace_memories`
- CLI: `oxagen memory list`
- Authentication: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface. The in-app agent never receives workspace memories.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `states` | array of `waiting \| in_pr \| promoted \| dismissed \| retired` | Default `waiting`, `in_pr` |
| `harness` | `claude-code \| codex \| cursor \| stella \| claude-desktop`? | Memories whose source starts with `<harness>:` |
| `agent` | `string`? | The agent's lineage |
| `repository` | `string`? | `<host>/<owner>/<name>`, such as `github.com/acme/api`. Memories whose `repos` hold it |
| `type` | `string`? | A Claude Code memory type: `user`, `feedback`, `project`, or `reference` |
| `limit` / `offset` | `int` | Groups, 1 to 200, default 50 / default 0 |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `groups[].memory` | memory | The highest ranked memory of the group |
| `groups[].members` | memory[] | Every memory in the group, in ranking order |
| `groups[].use_count` | `int` | The members' uses added together |
| `groups[].last_used_at` | RFC 3339 or null | The newest use of any member |
| `total_groups` | `int` | Groups across every page |
| `total_memories` | `int` | Memories that matched, up to 2,000 |
| `truncated` | `boolean` | True when more than 2,000 memories matched |
| `waiting` | `int` | The workspace's waiting memories, whatever the filters |

A memory carries `id` (`mem_…`), `label`, `summary`, `statement`, `state`, `capture`, `harness`, `agent`, `source`, `repos`, `memory_type`, `kind`, `use_count`, `use_signal`, `last_used_at`, `created_at`, `promoted_lineage`, and `memory_pr` (`number`, `url`, `status`, or null).

## Semantics

The list ranks memories by uses, then by the newest use, then by the newest capture, the curator's order ([ADR-248](../adr/ADR-248-memories-keep-their-rows-and-rank-by-use.md)). `use_count` is the distinct runs that used the memory, plus the uses a harness counted with no run.

Memories that say the same thing share one group: the same statement hash, or the word-overlap test the curator uses (80% of their content words in common, and neither one negates alone). A group stays inside one repository. The handler groups the 2,000 highest ranked memories that match, then cuts the page from the groups.

`use_signal` is false for a memory whose harness reports no use, such as one from `remember_lesson`, so a zero count reads as "No signal" and not as unused.

Memories are not embedded. A memory steers only the agent that wrote it, through its harness, and reaches other agents only once a person promotes it with [promote_memories](steering.memories.promote.md) and the memory PR merges.
