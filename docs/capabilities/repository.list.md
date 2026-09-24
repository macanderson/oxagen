# list_repositories

Every repository the workspace binds, its one main repository and each linked one (MC spec §10.1), for the Repositories page, the CLI and MCP.

One row per binding head, carrying the binding version the head points at. The main repository sorts first; the linked ones follow by full name. `connectionLive` is false when the GitHub connection behind a head has been retired, the state in which that repository silently stops resolving: `delete_connection` leaves the old row at `status = 'deleting'` and the head goes on pointing at it. The list still shows the repository, with that flag, rather than dropping it, the same judgement `get_main_repository` makes through the same predicate.

Makes no GitHub call. Every fact here is local, so the list renders while GitHub is down.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/repositories` → 200
- MCP: `list_repositories`
- CLI: `oxagen repo list [--json]`
- Authentication: session or API key; org Owner or Admin, or a workspace Owner or Member (the contract's default roles)
- Capability name: `list_repositories`
- Not billed (`noBillingGate: true`); IAM default-deny; low sensitivity

## Input

None. The org and workspace come from the capability context.

## Output

| Field | Type | Description |
|---|---|---|
| `repositories[].bindingId` | string | `rpb_…`, the binding version the head points at; what `unlink_repository` takes |
| `repositories[].role` | `"main"` or `"linked"` | exactly one row is `main` |
| `repositories[].owner` | string | the owner login as the binding recorded it |
| `repositories[].name` | string | the repository name as the binding recorded it |
| `repositories[].fullName` | string | `owner/name` as GitHub reported it when the binding was written |
| `repositories[].defaultRef` | string | the approved default ref, the binding's `configured_default_ref` |
| `repositories[].provider` | `"github"` \| `"gitlab"` | the host (#3762) |
| `repositories[].htmlUrl` | string | the repository on GitHub or the project on gitlab.com, derived from `fullName` |
| `repositories[].boundAt` | string | RFC 3339; when the head was written |
| `repositories[].connectionLive` | boolean | false when the connection behind the head is retired |
| `repositories[].events` | `installed`, `suspended`, `uninstalled`, `paused`, `retired`, `unknown` | whether GitHub can deliver the repository's events: the App installation's lifecycle and the connection's state. `installed` is the precondition for delivery, not a claim that an event arrived. A GitLab project reads `installed` when its connection is live and Oxagen registered the project webhook, and `unknown` when no webhook is registered |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | IAM | the principal holds none of the default roles |

A workspace with no heads answers an empty list. That state is reachable only for the organization's first workspace, which `create_org` writes without a main repository (spec line 222: onboarding binds it later through the installer, inside a 14-day provisional window). Every workspace `create_workspace` writes has its main head from its first instant.
