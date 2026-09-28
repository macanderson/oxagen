# repair_steering_repo

Put every prescribed setting back on the workspace's steering repo, then read the settings again and answer the health that read finds (steering-repo-spec, Settings drift; lane S2, #4560).

The health banner's Repair settings button calls this when the steering repo is not healthy. While health is not `healthy`, Oxagen merges nothing and publishes nothing, and runs keep the last published version.

**Surfaces:** api, mcp

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/repo/repair` with the body `{}` returns 200
- MCP: `repair_steering_repo`
- Agent: none. Repair is the health banner's admin button, so the contract carries no agent metadata
- CLI: none
- Authentication: org Owner or Admin, checked by the handler (INV-29). A call that carries only an API key names no user, so the role check refuses it (`no_principal`) on every surface
- Not billed (`noBillingGate: true`), IAM default-deny, high sensitivity

## Input

None. The org and workspace come from the capability context.

## Output

| Field | Type | Description |
|---|---|---|
| `health` | `healthy`, `drifted`, `disconnected`, or `diverged` | the health the read after the repair found |

## What a repair does

1. Writes every baseline setting the host shows differently.
2. When `main` diverged from the published commit, merges the pull request that puts `main` back at that commit. The published version does not change, and the repair records no new deployment.
3. Reads the health again. That read posts the checks and comments, so every open pull request sees the new state.

A setting that still differs after the write leaves the answer `drifted`. The repair does not fail for it.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
| `not_found` | `steering_repo_not_ready` | the workspace has no steering repo that is ready |
| `conflict` | `steering_app_unconfigured` | this deployment has no Oxagen Steering app settings |
| `conflict` | `steering_repo_disconnected` | Oxagen can no longer reach the repository. An organization admin must connect it again |
| `conflict` | `steering_revert_refused` | the host would not merge the pull request that puts `main` back, such as when `main` moved. Select Repair settings again |
