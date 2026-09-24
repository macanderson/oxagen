# repository.working_copy.list

Lists the directories the CLI linked to this workspace (MC spec §10.1), most recently seen first, for the Repositories page's Working copies tab.

Each row is what `record_working_copy` last received for one machine and directory. Nothing here reads a working tree, so a row describes its directory as of its `lastSeenAt` and no later. The reporter is the person whose session sent the latest report, with the display name their account carries. A report sent with an API key has no reporter.

**Surfaces:** api, mcp

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/working-copies[?limit=N]` → 200
- MCP: `list_working_copies`
- App: the Repositories page's Working copies tab
- Authentication: session or API key; org Owner or Admin, or a workspace Owner, Admin, Member, or Viewer
- Capability name: `list_working_copies`
- Not billed (`noBillingGate: true`); IAM default-deny; low sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `limit` | integer | no | 1 to 200; defaults to 100 |

## Output

`workingCopies` is an array, newest `lastSeenAt` first. Each row:

| Field | Type | Description |
|---|---|---|
| `id` | string | `wcp_…` |
| `hostname` | string | the machine's hostname |
| `directory` | string | the absolute path on that machine |
| `repository` | string or null | `owner/name` from the `origin` remote |
| `branch` | string or null | the checked-out branch |
| `headCommit` | string or null | the head commit at the last report |
| `oxagenPresent` | boolean | whether `.oxagen/` existed at the last report |
| `symlinks` | `linked`, `missing`, `none` | the state of stella's symlinks into `.oxagen/` |
| `pulledCommit` | string or null | the published commit the last `oxagen pull` wrote |
| `lastEvent` | `init` or `pull` | the command that sent the last report |
| `reportedBy` | object or null | `{ userId, name }` of the person who sent the last report; `name` is null when the account has no display name; the whole field is null for an API key |
| `cliVersion` | string or null | the CLI version that sent the last report |
| `firstSeenAt` | string | RFC 3339 |
| `lastSeenAt` | string | RFC 3339 |

## Refusals

The input schema refuses a `limit` outside 1 to 200. The handler adds no refusal of its own.
