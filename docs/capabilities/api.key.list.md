# list_api_keys

**Capability:** `list_api_keys`
**Domain:** api_key
**Mode:** sync
**Scope:** org + workspace (the tenant scope the caller enters)
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; a console read is never a governed action, ADR-052 exclusion 2)

## Intent

List the API keys in the caller's tenant scope with the metadata an API keys page shows. Each item carries the public id, name, prefix, creation time, last use, expiry and revocation time. Revoked keys are included with their `revokedAt`; a live key has `revokedAt: null`. Each item also says whether it is `rotatable`, so a surface does not offer a rotation `rotate_api_key` is certain to refuse; both read the one answer in `packages/handlers/src/lib/api-key-rotatable.ts`, which covers a server-owned scope purpose, an expiry that has passed, a revoked key, and a workspace that has been archived.

The output never carries a key's secret or its hash. The raw key is returned once by `create_api_key` and never stored; the SHA-256 hash stays in the row. The contract test walks the output schema and refuses any field whose name matches `/secret|hash|key$/`, and the handler selects its columns by name so `key_hash` is never read.

## Input

None (an empty object).

## Output

| Field | Type | Notes |
|---|---|---|
| `items[].publicId` | `string` | The `aky_*` public identifier. |
| `items[].name` | `string` | The label given at creation. |
| `items[].prefix` | `string` | The fixed leading window of the raw key, for recognition. |
| `items[].createdAt` | `string` | ISO-8601 creation timestamp. |
| `items[].lastUsedAt` | `string \| null` | ISO-8601 timestamp of the last request, or null when the key has not been used. |
| `items[].expiresAt` | `string \| null` | ISO-8601 expiry, or null for a non-expiring key. |
| `items[].revokedAt` | `string \| null` | ISO-8601 revocation timestamp, or null for a live key. |
| `items[].rotatable` | `boolean` | Whether `rotate_api_key` will replace this key, as at the instant of this read. False for a key an enrollment or a login flow owns — a Tacho host, an agent credential, a Stella telemetry key, a CLI session key — whose lifecycle belongs to that service, and false for a key whose expiry has passed, because rotation copies the rotated key's expiry onto the replacement, and false for a revoked key, because this read returns revoked rows and `rotate_api_key` answers not-found for one, and false for every key in an archived workspace, because a rotation mints fresh secret material and that is what archival exists to stop — this last one is a property of the workspace rather than of the key, so it turns the whole page's rotations off at once. A caller that holds this value across the expiry must expect `rotate_api_key` to refuse; the handler judges against its own clock and is the authority. Revocation is always available, whatever the purpose or the expiry. |

Items are ordered newest first.

## Roles

Org Owner, Org Admin. The handler checks the role; the kernel's IAM check allows every capability for a non-enterprise org.

## Side effects

None. Read-only; audit-exempt (the lifecycle writes `create_api_key`, `revoke_api_key` and `rotate_api_key` each emit their own `api_key.*` event).

## Surfaces

- `GET /api/v1/{org}/{ws}/api-keys`
- MCP tool `list_api_keys`

## Errors

| code | meaning |
|---|---|
| `authz_denied` | No authenticated principal, no org or workspace scope, or the caller is not an org Owner or Admin. |
