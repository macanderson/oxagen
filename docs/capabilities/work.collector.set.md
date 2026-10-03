# set_work_collector

Create or change a GitHub work collector by name, or pause and resume one (lane P1-03, #5103).

**Surfaces:** api

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/collectors/set`, returns 200
- Not on the MCP, CLI, or agent surface.
- Authentication: A signed-in session. An API key or an agent run is refused before anything is written.
- Roles: org Owner or Admin, or workspace Owner, checked by the handler
- Billing: `noBillingGate: true`

A collector decides what the workspace takes in, so only a person changes one ([ADR-250](../adr/ADR-250-phase-1-work-intake-reads-github-through-the-github-app-and-triage-cites-a-steering-record.md), #5181). An agent on its operator's machine can read the operator's `oxagen login` key, so every API key is refused. An agent can still file a work item with `create_work_item`.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Lowercase words joined by single hyphens, up to 64 characters |
| `connection_id` | `string?` | The workspace's GitHub connection, `con_…`. Optional. It must be the connection the repositories were linked through |
| `repos` | `string[]?` | 1 to 50 repositories, `owner/name`, each linked to the workspace. Required to create |
| `paused` | `boolean?` | True pauses the collector. False resumes it |

A change keeps whatever the input leaves out.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `collector` | object | The collector as `list_work_collectors` returns it |
| `created` | `boolean` | |
| `reconcile_queued` | `boolean` | True when a reconcile was queued: the collector is new, resumed, or reads a changed set of repositories |

## Semantics

Each repository must be linked to the workspace: its steering repository, or one a merged `link_repository` change linked. The collector reads through the connection those repositories were linked through, so they must share one. The connection must belong to the workspace and be connected. A repository the workspace unlinks later drops out of every collector's reads and webhook deliveries. A collector whose repositories are all unlinked records each scheduled read as failed, with that reason, and turns failing after three. A collector that gains a repository, or moves to another connection, reads every repository from the start again, because its cursor is a time and the new repository's older issues were never read. Issues GitHub had already closed when a collector first reads them do not become work items. Each repository must be one the Oxagen GitHub App can read, and a reconcile fails until it can. The row stores the fields of a `collector/v1` document with every write-back switch off, and the SHA-256 of that document ([ADR-250](../adr/ADR-250-phase-1-work-intake-reads-github-through-the-github-app-and-triage-cites-a-steering-record.md)). Oxagen reads GitHub and writes nothing back to an issue. Pausing keeps each webhook delivery and fetches nothing until a person resumes the collector.

Errors: 400 for a new collector with no repositories, a repository the workspace does not link, repositories linked through more than one connection, or a `connection_id` other than theirs, 403 for an API key or an agent run (`person_required` or `agent_run`) and for a caller without the role, 404 for a connection the workspace does not hold, 409 for a connection that is not connected or a name another collector type holds.
