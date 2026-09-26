# search_tools

The belt search meta-tool and the ⌘K search over the workspace's own records (MC spec App. E, §6.6). One ranked index over four kinds, at most eight rows.

- `tool`: capabilities the in-app agent may call — the contracts exposed on the `agent` surface — ranked by name and description. Inside a turn the engine-facing twin reads the materialised set, so what the model cannot call it cannot find.
- `run`: the workspace's ledger runs by public id or goal and its wrapped-agent sessions by public id, the in-app agent's own turns excluded as in `list_runs`.
- `agent`: the workspace's agents by slug or name. A retired (`archived`) agent does not appear.
- `approval`: pending, unexpired approvals by id or the capability they parked.

Rows carry ids and no hrefs: the app builds every navigation target from a typed route builder (`apps/app/ARCHITECTURE.md` INV-13). Ontology is out of scope; nothing here reads the graph.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/tools/search`
- MCP: `search_tools`
- Agent: `search_tools` (belt meta-tool)
- Authentication: session (org Owner, Admin or Member; workspace Owner, Member or Viewer)
- Capability name: `search_tools`
- Not billed (`noBillingGate: true`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `query` | string | no | up to 500 characters; empty returns the newest rows of each kind. `%` and `_` match themselves |
| `kinds` | enum[] | no | non-empty subset of `tool`, `run`, `agent`, `approval`; omit for all. A kind not asked for is not read |

## Output

| Field | Type | Description |
|---|---|---|
| `rows` | object[] | at most 8; tools first, then records newest first within a kind |

Each row: `kind`, `id` (a public id or a capability name), `label`, `contextLine` (a status, a description or an expiry; null when the row has none).

## Honesty

Every record read runs inside the tenant scope and names `org_id` and `workspace_id`, so a stack with the RLS bypass on still answers for one workspace.
