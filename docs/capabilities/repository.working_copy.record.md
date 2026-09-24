# repository.working_copy.record

Records a directory the CLI linked to this workspace (MC spec §10.1), so the Repositories page's Working copies tab can show where the workspace's steering was written.

`oxagen init` sends the report after it writes `.oxagen/workspace.json`. `oxagen pull` sends it after it writes the published `.oxagen/` tree. The store keeps one row per machine and directory. A second report from the same pair updates that row: it overwrites every reported field, the event, the reporter, and `lastSeenAt`, and keeps `firstSeenAt` and the row's id.

The report carries what the machine can see about the directory: the `origin` remote, the branch, the head commit, whether `.oxagen/` exists, and the state of stella's symlinks into it. It never carries a file's contents. `machineId` is a hash the CLI derives on the machine, never a hardware serial. A working copy's state is never a run's state, because steering reaches a run from the merged commit.

**Surfaces:** api, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/working-copies` → 200
- CLI: `oxagen init` and `oxagen pull` send it after they write `.oxagen/`
- Authentication: session or API key; org Owner or Admin, or a workspace Owner, Admin, or Member
- Capability name: `record_working_copy`
- Not billed (`noBillingGate: true`); IAM default-deny; low sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `machineId` | string | yes | 16 to 128 lowercase hex characters |
| `hostname` | string | yes | 1 to 255 characters |
| `directory` | string | yes | the absolute path on the machine, 1 to 1024 characters |
| `repository` | string or null | yes | `owner/name` from the `origin` remote; null without one |
| `branch` | string or null | yes | the checked-out branch |
| `headCommit` | string or null | yes | a 7 to 64 character hex sha |
| `oxagenPresent` | boolean | yes | whether `.oxagen/` exists in the directory |
| `symlinks` | `linked`, `missing`, `none` | yes | `none` when the directory has no `.stella/` |
| `pulledCommit` | string or null | yes | the published commit the last `oxagen pull` wrote; null before one |
| `event` | `init` or `pull` | yes | the command that sent the report |
| `cliVersion` | string or null | yes | up to 64 characters |

## Output

| Field | Type | Description |
|---|---|---|
| `workingCopyId` | string | `wcp_…`, the same for every report from this machine and directory |
| `firstSeenAt` | string | RFC 3339; when the first report arrived |
| `lastSeenAt` | string | RFC 3339; when this report arrived |

## Refusals

The input schema refuses a malformed report before the handler runs. The handler adds no refusal of its own.
