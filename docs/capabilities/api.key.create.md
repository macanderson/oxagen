# api.key.create

**Domain:** api_key
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Create a new API key scoped to the requesting org. The raw key is returned exactly once — it is never stored in plaintext (only the SHA-256 hash and a short prefix are persisted). Callers must save the raw key immediately; it cannot be retrieved later. Audited as `api_key.created`.

## Input

| Field | Type | Notes |
|---|---|---|
| `name` | `string` (1–120 chars) | Human-readable label for the key. |
| `scope` | `Record<string, unknown>?` | Optional scope constraints. Default `{}`. Reserved for future use. |
| `expiresAt` | `string?` (ISO-8601 datetime) | Optional expiry. Omit for a non-expiring key. |

## Output

| Field | Type | Notes |
|---|---|---|
| `keyId` | `string` | Internal UUID of the created key. |
| `publicId` | `string` | Prefixed public identifier (`aky_` prefix). |
| `name` | `string` | The label provided on creation. |
| `keyPrefix` | `string` | Short prefix stored for index lookup (safe to display). |
| `rawKey` | `string` | The full API key — shown **once only**, never again. |
| `expiresAt` | `string \| null` | ISO-8601 expiry or null. |
| `createdAt` | `string` | ISO-8601 creation timestamp. |
| `render` | `RenderDirective?` | Chat UI directive for displaying the key (agent surface only). |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: inserts `org.api_keys` row with hashed key; never stores plaintext.
- ClickHouse: emits `api_key.created` audit event.

## Surfaces

- `POST /api/v1/{org}/{ws}/api-keys`
- MCP tool `api_key_create`
- Agent: requires `agent.requiresApproval = false`, risk `medium` — surfaced as a tool in the org-management category.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `validation_error` | Input failed Zod parse. |
