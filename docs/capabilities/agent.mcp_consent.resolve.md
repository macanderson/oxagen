# agent.mcp.consent.resolve

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Grant or deny first-use consent for an external MCP tool. The decision
resumes the paused agent stream and is remembered for subsequent calls so
the same tool no longer re-prompts. When `grantAllTools` is set on a
`granted` decision, every tool on the server is pre-granted.

## Input

| Field           | Type                       | Notes                                                                          |
| --------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `approvalId`    | `string`                   | The pending consent request id (the underlying approval row id) to resolve.    |
| `decision`      | `"granted" \| "denied"`    | Grant or deny first-use consent.                                               |
| `grantAllTools` | `boolean?`                 | When true (and `decision=granted`), pre-grant every tool on the server (`*`).  |

## Output

| Field        | Type                                  | Notes                                  |
| ------------ | ------------------------------------- | -------------------------------------- |
| `approvalId` | `string`                              | The resolved consent request id.       |
| `resolution` | `"granted" \| "denied" \| "expired"`  | Final resolution of the consent.       |

## Side effects

- Postgres: upsert `agent.mcp_consents` grant row(s); resolve the backing approval row.
- ClickHouse: emit `agent.mcp.consent.resolved` event.
- Resumes the paused agent stream waiting on the consent gate.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
