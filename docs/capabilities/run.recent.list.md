# list_recent_runs

The ⌘K Runs group (MC spec App. E): the newest runs of the workspace with the four fields a menu row shows. It reads through the `list_runs` handler, so both stores are merged newest first and the in-app agent's own turns stay out.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp, agent

- API: `POST /v1/:org_slug/:workspace_slug/runs/recent`
- MCP: `list_recent_runs`
- Agent: the in-app assistant finds it with `search_tools` and loads it with `load_tools`. Low risk, no approval.
- Authentication: session (org Owner, Admin or Member; workspace Owner or Member)
- Capability name: `list_recent_runs`
- Not billed (`noBillingGate: true`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `limit` | integer | no | 1-10, default 8 |

## Output

| Field | Type | Description |
|---|---|---|
| `runs` | object[] | at most 10, newest first |

Each row:

| Field | Type | Description |
|---|---|---|
| `id` | string | `arun_…` or `tse_…` |
| `agentKey` | string or null | `org_ns.ws_ns.slug`; null when the ledger row names no agent |
| `status` | enum | `live`, `sealed`, `halted` |
| `startedAt` | string | RFC 3339 |
