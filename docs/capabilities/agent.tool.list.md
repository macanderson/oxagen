# agent.tool.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the capabilities surfaced as agent tools for the active workspace,
after the workspace's allowlist and risk policy filter the registry.
The runtime calls this on every turn to materialize the Vercel AI SDK
tool map; humans see the same list in the agent-tools panel.

## Input

| Field             | Type      | Notes                                                          |
| ----------------- | --------- | -------------------------------------------------------------- |
| `includeExternal` | `boolean` | Include tools proxied from registered external MCP servers. Defaults to `true`. |

## Output

| Field   | Type                  | Notes                                          |
| ------- | --------------------- | ---------------------------------------------- |
| `tools` | `Tool[]`              | Materialized agent tool list, after filtering. |

Each tool: `{ name, description, domain, category | null, riskLevel, requiresApproval, external }`.

## Side effects

None — read-only against the in-process capability registry plus the
workspace policy row.

## Errors

| code               | meaning                                       |
| ------------------ | --------------------------------------------- |
| `workspace_locked` | Workspace policy is being edited; retry soon. |

## SPEC references

- §3.1 — unified capability/tool model
- §4 — new capabilities
