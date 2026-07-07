# agent.mcp.consent.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List external MCP tool consent grants in the active workspace — which tools
the agent may invoke without re-prompting. By default this returns the full
workspace policy view; pass `mineOnly` to scope it to the calling user.

## Input

| Field      | Type        | Notes                                                                       |
| ---------- | ----------- | --------------------------------------------------------------------------- |
| `mineOnly` | `boolean?`  | When true, return only the calling user's grants. Default false = all grants. |

## Output

| Field      | Type                | Notes                                  |
| ---------- | ------------------- | -------------------------------------- |
| `consents` | `Consent[]`         | Array of consent grant records.        |

Each `Consent`:

| Field         | Type                    | Notes                                       |
| ------------- | ----------------------- | ------------------------------------------- |
| `publicId`    | `string`                | Public id of the consent grant.             |
| `userId`      | `string`                | User the grant belongs to.                  |
| `mcpServerId` | `string`                | Server the grant applies to.                |
| `toolName`    | `string`                | Tool name, or `*` for all tools.            |
| `status`      | `"granted" \| "denied"` | Current grant status.                       |
| `grantedAt`   | `string \| null`        | ISO timestamp when granted, if granted.     |
| `deniedAt`    | `string \| null`        | ISO timestamp when denied, if denied.       |
| `expiresAt`   | `string \| null`        | ISO expiry timestamp, if the grant expires. |

## Side effects

- None (read-only).

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
