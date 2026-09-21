# context.governance_mode.set

Set the steering governance mode a workspace runs under (ADR-061; MC spec §10.2, §10.3 step 3).

The mode is not a column. ADR-061 decision 1 puts it in `.oxagen/rules/governance.toml` on the production branch of the workspace's main repository and rejects a database cache, so `open_context_pr` and `merge_context_pr` read the file itself every time. A write here is a commit to that file. Before this capability, `open_init_pr` wrote the first copy and then refused once `.oxagen/` existed, so the only way to change the mode was a hand-made pull request on GitHub.

**The mode in force decides how it may be changed.** Loosening governance is the change a strict mode most needs to see coming, so the route is read off the current file, not off the caller's intent. Under `solo` the change is committed to the production branch, because a review step would guard nothing where one person already publishes alone. Under `team` and `regulated` it opens an ordinary pull request against the production branch for a person to merge on GitHub: Oxagen runs no checks on it and `merge_context_pr` does not merge it. A `governance.toml` that exists but cannot be parsed takes the same reviewed route, because a mode nobody can establish must not be treated as the permissive one.

**`applyImmediately` skips the review and is recorded.** Every role that can call this capability at all already holds the override, and any of them could commit the same file on GitHub by hand, so the review route is a default rather than a gate. What the override buys is a record: it emits `steering.governance_overridden` naming the caller, the mode it left and the mode it set. Under `solo` it changes nothing.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/governance-mode` → 200
- MCP: `set_governance_mode`
- CLI: `oxagen repo governance --mode solo|team|regulated [--workspace <ws_…>] [--apply-now] [--json]`
- App: Organization › Workspaces › Edit workspace, the "Steering governance" field. Its default is "Leave unchanged", so a rename invokes this capability not at all
- Authentication: session or API key. An org Owner or Admin for any workspace of the organization; an Owner or Admin of the scoped workspace for that workspace alone. Checked by the handler
- Capability name: `set_governance_mode`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity; agent calls require approval

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `workspaceId` | string | no | `ws_…`; the scoped workspace when omitted |
| `mode` | string | yes | `solo`, `team` or `regulated` |
| `applyImmediately` | boolean | no | default false; commit although the mode in force asks for review |

## Output

| Field | Type | Description |
|---|---|---|
| `outcome` | string | `applied`, `proposed` or `unchanged` |
| `requestedMode` | string | the mode asked for, so a proposal says what is waiting |
| `previousMode` | string \| null | what the file declared before; null when it was absent or unreadable, never `team` |
| `effectiveMode` | string \| null | the mode in force now; the unchanged current mode when `proposed` |
| `fullName` | string | `owner/name` of the main repository |
| `productionBranch` | string | the branch the change landed on or is proposed against |
| `commitSha` | string \| null | the commit when `applied` |
| `pullRequest` | object \| null | `{ number, htmlUrl, reused }` when `proposed`; `reused` is true when a pull request already open on `oxagen/governance` was updated |
| `overrodeReview` | boolean | true when the caller spent `applyImmediately` and the mode in force had asked for review |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no acting user, or the roles above are missing |
| `not_found` | `workspace_not_found` | no workspace of this organization carries the id |
| `conflict` | `workspace_archived` | the workspace is archived |
| `conflict` | `github_not_connected` | the workspace has no installation to write through |
| `not_found` | `repository_not_installed` | the installation cannot see the main repository |
| `conflict` | `production_branch_missing` | the binding's production branch is gone from GitHub |
| `conflict` | `github_refused` | GitHub refused the write, with its own message |

There is deliberately no refusal for `applyImmediately` without the role: the roles that may override are exactly the roles that may call this, so such a refusal would be unreachable, and an unreachable refusal reads as a guarantee the code does not make.

## Events

| Event | When |
|---|---|
| `steering.governance_changed` | the mode moved — an `applied` outcome, whether or not the review was skipped |
| `steering.governance_overridden` | additionally, when `overrodeReview` is true |

Both are emitted for an override, so neither "every governance change" nor "every skipped review" is a filter that quietly misses rows. A `proposed` outcome emits neither: nothing has changed until someone merges the pull request.
