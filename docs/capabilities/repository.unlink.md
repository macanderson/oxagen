# unlink_repository

Remove a linked repository from the workspace. A repository that the steering record lists is removed by a steering PR (ADR-212, ADR-099).

The repository is addressed by the `rpb_…` binding id `list_repositories` answers. What happens next depends on the steering record:

- When `.oxagen/workspace.toml` on the steering repository's production branch lists the repository, the handler opens a steering PR that removes the entry. It answers `status: proposed`. The head goes away when that PR merges and the steering sync reads the new `workspace.toml`. Until then the repository stays linked. The PR carries a `workspace` proposal ([ADR-265](../adr/ADR-265-every-steering-pr-oxagen-opens-carries-a-proposal-row.md), #5122), so a person merges it from Oxagen with [`merge_steering_pr`](steering.pr.merge.md).
- When `workspace.toml` does not list it, the link predates the steering record, and no edit to the file would remove it. The handler deletes the head at once under the workspace's repository lock and answers `status: unlinked`.

Either way, every binding version stays: `ingestion.repository_bindings` is immutable evidence that runs admitted against it still cite. Linking the repository again writes a successor version, not a second version 1.

The steering repository is never removed by this write. A workspace always has one steering repository, so a steering head refuses with `conflict: main_repo_unlink_refused`.

**Surfaces:** api, mcp, agent, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/unlink` → 200
- MCP: `unlink_repository`, on an API-key context whose key has a live creator (`resolveActingUserId`)
- CLI: `oxagen repo unlink <bindingId> [--json]`
- Authentication: session or API key. The handler admits an org Owner or Admin, or the workspace's Owner (INV-29).
- Capability name: `unlink_repository`
- Not billed (`noBillingGate: true`). IAM default-deny. Medium sensitivity.
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: medium`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `bindingId` | string | yes | `rpb_…`, the binding version the head currently points at |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | the id that was given |
| `fullName` | string | `owner/name` of the repository |
| `status` | `"unlinked"` or `"proposed"` | `unlinked`: the head is gone. `proposed`: a steering PR removes the entry, and the head goes when it merges. |
| `unlinkedAt` | string or null | RFC 3339 when `status` is `unlinked`, null while a steering PR is open |
| `steeringPullRequest` | object or null | `{ number, url, reused }` for the steering PR from `workspace/unlink-<owner>-<name>-<hash>`, or null when `status` is `unlinked` |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no acting user, or the caller is not an org Owner or Admin or the workspace's Owner |
| `not_found` | `repository_not_linked` | no head in this workspace points at that binding id |
| `conflict` | `main_repo_unlink_refused` | the head is the workspace's steering repository |
| `conflict` | `workspace_toml_unreadable` | `workspace.toml` names `workspace/v1` on its first line and does not read against it, so the handler cannot tell which path applies |
| `conflict` | `github_refused` | GitHub refused a read, the branch, the file, or the pull request |

A missing `workspace.toml`, or one whose first line names another schema, lists nothing, so the handler deletes the head at once.

Row-level security and explicit org and workspace predicates both bound the read that finds the head. A binding id from another workspace is `not_found` and never a hint that the id exists elsewhere. The direct delete runs under the same transaction-scoped advisory lock the other repository writers take, and it reads the head again under that lock.

## What this write does not do

Nothing is purged from the graph. The v2 descriptor at `packages/oxagen/src/contracts/v2/unlink-repository.ts` carries the purge-and-deregister target shape until its cutover, and ADR-099 records the deferral.
