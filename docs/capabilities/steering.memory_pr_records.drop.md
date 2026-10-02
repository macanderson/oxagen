# drop_memory_record

Drop one proposed steering record from an open memory PR (#4518). The handler pushes a commit to the PR's branch that deletes the record's file. When the PR merges, its settlement rejects the dropped record's statements, and the memories it cited wait again.

**Surfaces:** api, mcp, cli

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/memory-prs/records/drop`, returns 200
- MCP: `drop_memory_record`
- CLI: `oxagen memory drop <number> <path>`
- App: Steering › the steering PR page of a memory PR, the Drop button on each record
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `number` | `int` | The memory PR's number in its steering repository, as `list_memory_pr_records` takes it |
| `path` | `string` | The record file to drop, as `list_memory_pr_records` names it |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `pull_request` | `{ number, url, branch }` | The memory PR |
| `path` | `string` | The record file |
| `lineage` | `string` | The record's lineage |
| `commit_sha` | `string` | The commit on the branch that deleted the file |
| `already_dropped` | `boolean` | True when the branch no longer held the file, and `commit_sha` is the newest commit that touched its path |

## Semantics

The memory PR row lists each record the PR proposes or archives, and the statements and memories each one cites. The drop writes nothing to that row. When the PR merges, the curator settles it ([ADR-206](../adr/ADR-206-memories-wait-in-oxagen-and-reach-a-repository-by-a-memory-pr.md) decision 7, as [ADR-248](../adr/ADR-248-memories-keep-their-rows-and-rank-by-use.md) amends it): a proposed record whose file is not at the merge commit did not merge, so its statement hashes go to `agent.memory_rejections` and its memories wait again. A PR closed unmerged rejects every record.

The handler:

1. Checks the contract's roles.
2. Finds the memory PR by its number. When the workspace's memory PRs hold the number on more than one repository, the newest one answers.
3. Refuses a memory PR the row says settled, a path the PR does not hold, and a record the PR archives.
4. Reads the PR on the steering host. It refuses a PR on another repository than the workspace's steering repo, and a PR the host merged or closed before the curator settled it.
5. Reads the branch. A file the branch no longer holds is answered with the commit that removed it, with `already_dropped` true.
6. Refuses the PR's last record. A memory PR with nothing left to merge is closed instead, which rejects every record.
7. Commits the delete on the head it read. The host refuses `head_moved` when someone pushed in between.

[`list_memory_pr_records`](steering.memory_pr_records.list.md) marks the record dropped once the branch no longer holds its file.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `not_found` | `memory_pr_not_found` | The workspace has no memory PR with that number. |
| `not_found` | `record_not_in_pr` | The memory PR holds no record at the path. |
| `conflict` | `memory_pr_settled` | The memory PR is merged or closed. |
| `conflict` | `record_not_proposed` | The PR archives the record. Only a proposed record can be dropped. |
| `conflict` | `memory_pr_elsewhere` | The PR is on a repository the workspace no longer uses. |
| `conflict` | `branch_missing` | The PR's branch is gone from the repository. |
| `conflict` | `record_file_missing` | The branch never held the file. |
| `conflict` | `last_record` | The record is the last change the PR makes. Close the PR instead. |
| `conflict` | `head_moved` | Someone pushed to the branch while the drop ran. Drop the record again. |

The commit publishes nothing, so the handler emits no security event. The kernel's `capability.invoke_*` audit records the call.
