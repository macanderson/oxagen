# migrate_tools_to_steering

Move the workspace's connected MCP servers into its steering repo (ADR-209 §5, ADR-245, #4948).

A workspace that connected MCP servers before it had a steering repo keeps them as rows in Oxagen, and `register_mcp_server`, `set_plugin_enabled`, and `import_tools` write those rows directly. This capability opens the migration steering PR: one `tools/servers/<name>/` folder for each server a wrapped agent may use, built from today's rows and pinned tool snapshots. A workspace with more than 299 files to move gets one PR per batch. When every batch merges, the next publish takes each server's row over, and from then on a change to the workspace's tools is a steering PR.

Oxagen starts the same migration when a workspace's steering repo finishes provisioning, so you call this capability to start a workspace that was never started, or to retry one that failed.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/tools/steering/migrate` with the body `{}` returns 200
- MCP: `migrate_tools_to_steering`
- CLI: `oxagen tools migrate [--json]`
- Authentication: org Owner or Admin, checked by the handler (INV-29). A call that carries only an API key names no user, so the role check refuses it (`no_principal`) on every surface
- Not billed (`noBillingGate: true`), IAM default-deny, high sensitivity

## Input

None. The org and workspace come from the capability context.

## Output

| Field | Type | Description |
|---|---|---|
| `state` | `opened`, `already_open`, or `already_migrated` | what the call found or did |
| `pullRequest` | `{ number, url }` or null | the first migration PR. Null when the workspace never needed one |
| `pullRequests` | array of `{ number, url }` | every migration PR, in batch order. One in most workspaces |

## States

| State | When | What the call does |
|---|---|---|
| `opened` | servers are left to move and no migration PR is open | opens the PRs and answers them |
| `already_open` | a PR an earlier call opened is still open | answers each open PR and opens nothing |
| `already_migrated` | no server is left to move, or each one left waits on the publish after its PR merged | answers the merged PRs, or none, and opens nothing |

"Migrated" means what `steeringWriter()` reads: the workspace has a steering repo, and no live, enabled, legacy row on the streamable-http transport is left. A `stdio` or `sse` server stays a legacy row and does not keep the workspace from migrating (ADR-211).

## Idempotency

Oxagen records each migration PR in the workspace's `tool_migration` setting the moment it opens, before the next batch opens. A repeat call reads that record, asks the host whether each PR is still open, and answers an open one instead of opening a second. A PR that closed unmerged is opened again under the same folder names. One call at a time holds the workspace. A run that stops without saving loses its hold after ten minutes.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user, or the caller is not an org Owner or Admin |
| `not_found` | `steering_repo_not_ready` | the workspace has no steering repo yet. `get_steering_repo` shows where its setup stands, `retry_steering_repo_provision` restarts a setup that stopped, and `import_workspace_steering` moves a workspace still steered from a code repository's `.oxagen/` folder. Then call this again |
| `conflict` | `servers_not_movable` | no PR opened because each server left cannot be written as a folder, such as a server whose URL has a query string. The message names each server and why. Fix, disable, or delete each one, then call this again |
| `conflict` | `tool_migration_running` | another call is moving the workspace's servers now. Call this again in a few minutes to get its PR |
| `conflict` | `steering_pr_unavailable` | this deployment registered no steering PR opener |
| `conflict` | the opener's reason, such as `tools_branch_exists` | the host refused the branch or the PR. The record keeps the reason, and a repeat call retries |
