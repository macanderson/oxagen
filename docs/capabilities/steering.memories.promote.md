# promote_memories

Promote waiting workspace memories into draft steering records on a memory PR (#4912). Each record cites its memories in `provenance.memories`, and nothing steers until a person merges the PR. This is the write behind the Memories tab's Promote dialog and `oxagen memory promote`.

**Surfaces:** api, mcp, cli

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/memories/promote`, returns 200
- MCP: `promote_memories`
- CLI: `oxagen memory promote <ids...>`
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `drafts[]` | draft | 1 to 50 drafts, one steering record each |
| `drafts[].memory_ids` | `string[]` | 1 to 50 `mem_…` ids. The first one's statement is the default body |
| `drafts[].statement` | `string`? | The record's body, up to 2,000 characters |
| `drafts[].kind` | `business-rule \| code-rule \| constraint \| procedure \| fact \| preference \| memory`? | Defaults to the kind the curator would write: the first memory's kind when it is `code-rule`, `business-rule`, or `fact`, else `memory` |
| `drafts[].force` | `must \| should \| may \| info`? | A force the kind allows (`forcesFor`). Defaults to `should` for a rule kind, `may` for a preference, and `info` for a fact or a memory |
| `drafts[].effect` | `require \| forbid`? | Required for a constraint, and refused for any other kind |
| `drafts[].repos` | `string[]`? | `<host>/<owner>/<name>` references. Defaults to the first memory's. With none, the record is workspace-wide |
| `same_text` | `boolean` | Default true. Each draft also cites the waiting memories that say the same thing as its first memory, in the same repository |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `pull_request` | `{ number, url, branch, opened }` or null | Null when no draft was left to add. `opened` is false when the drafts joined an open memory PR |
| `records[]` | `{ path, lineage, kind, force, effect, memory_ids }` | The records added, in the order of the drafts |
| `skipped[]` | `{ memory_id, reason }` | `not_found`, `not_waiting`, or `already_proposed` |

## Semantics

Only a waiting memory is cited. A memory this workspace does not hold, one in any other state, and one whose statement an open memory PR already proposes come back in `skipped`. A draft left with no memory is dropped, and a memory one draft cites is not cited again by a later one.

The drafts join the newest open memory PR on the workspace's steering repository as one commit on its branch, and its description gains a "Promoted records" section. When no memory PR is open, the handler opens one on today's branch, `memory/<YYYY-MM-DD>` in UTC, through the curator's path, or on `memory/<YYYY-MM-DD>-2` and up when today's branch already had a PR. The curator opens one memory PR a day from `memory/<date>`, so a person's PR on that branch stands in for the curator's PR that day.

Each record is a `steering-record/v1` file under `steering/memory/<repository or workspace>/<area>/<lineage>.md`, with the person's kind, force, and effect, `origin: user`, and `provenance.source: run`. The memory PR row lists it, and the memories it cites move to `in_pr`. The curator settles the PR as it settles its own ([ADR-245](../adr/ADR-245-memories-keep-their-rows-and-rank-by-use.md)): a record that merges promotes its memories, and one that does not returns them to waiting and rejects their statements.

Refusals, each a 409 conflict: `force_not_allowed`, `effect_required`, `effect_not_allowed`, `steering_repo_required` (the repository holds no `steering/governance.toml`), `memory_pr_full` (the PR would change more than 299 files), `memory_branch_taken`, `record_unreadable`, and `memory_pr_settled`. A workspace with no steering repository answers `not_found`.
