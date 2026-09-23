# @oxagen/plugins

The installable-plugin spine: encrypted plugin and workspace credentials,
OAuth for MCP servers, the capability entitlement gate, the workspace
credential vault and its environments, agent-to-environment bindings, and the
MCP registry catalog.

## Boundary

- **Owns:**
  - The capability entitlement gate the kernel runs for plugin-claimed
    contracts, with its 30-second per-workspace cache
    (`src/entitlements/`).
  - Encrypting and decrypting plugin credential secrets, workspace secrets,
    and credential grants (`src/credentials/`).
  - OAuth provider detection, the state store, preregistered clients, endpoint
    resolution, and marking a connection for re-authorization (`src/oauth/`).
  - The credential vault: secret keys and values, `.env` import and export,
    reveal, and per-environment resolution (`src/vault/`).
  - Environments and which environment an agent identity may resolve
    (`src/environments/`).
  - The MCP registry client, catalog row mapping, README rendering
    (`src/registry/`), and the sync into `mcp.catalog_servers`
    (`src/catalog-sync.ts`).
  - The stored run-outcomes consent policy (`src/run-outcomes-policy.ts`).
- **Does not own:**
  - Which plugin claims which contract. The manifest registry lives in
    [`@oxagen/oxagen`](../oxagen/README.md) (`src/plugins/`).
  - The kernel slot the gate plugs into: [`@oxagen/oxagen`](../oxagen/README.md).
  - Envelope encryption and KEK adapters: [`@oxagen/crypto`](../crypto/README.md).
  - File-based MCP settings on a developer machine:
    [`@oxagen/mcp-config`](../mcp-config/README.md).
  - Connecting to an MCP server and materializing its tools:
    [`@oxagen/agent`](../agent/README.md).
  - The durable jobs that run catalog sync and OAuth refresh on a schedule:
    [`@oxagen/inngest-functions`](../inngest-functions/README.md).
- **Depends on:**
  - `@oxagen/oxagen`: `setCapabilityEntitlementGate`,
    `capabilityNotInstalledError`, `pluginForContract`, `HandlerError`, and
    the run-outcomes policy type.
  - `@oxagen/database`: Postgres tables for installed plugins, credentials,
    the vault, environments, and the MCP catalog.
  - `@oxagen/crypto`: envelope encryption and the local KEK adapter for
    credential and vault secrets.
  - `@oxagen/iam`: the kill-switch guard on workspace credential writes.
  - `@oxagen/notifications`: the re-authorization notice to organization
    managers.
  - `@oxagen/tenancy`: tenant scope.
- **Used by:** `apps/api`, `apps/app`, `apps/app_deprecated`, `apps/mcp`,
  `@oxagen/agent`, `@oxagen/handlers`, and `@oxagen/inngest-functions`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `bootstrapEntitlementRuntime` | injection | `packages/plugins/src/entitlements/bootstrap.ts` | `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, `apps/app/instrumentation.ts` |
| `capabilityEntitlementGate` | adapter | `packages/plugins/src/entitlements/entitlement-service.ts` | Implements `CapabilityEntitlementGateFn` from `packages/oxagen/src/kernel.ts` |
| `resolveCredentialKms` / `resolveVaultKms` | adapter | `packages/plugins/src/credentials/kms.ts`, `packages/plugins/src/vault/vault-kms.ts` | Build `@oxagen/crypto`'s local KEK adapter. Called by `src/credentials/workspace-credential.ts` and `src/vault/vault-secret-service.ts`. |
| `syncAllRegistries` / `syncRegistry` | export | `packages/plugins/src/catalog-sync.ts` | `packages/inngest-functions/src/functions/plugin.catalog-sync.ts`, `packages/handlers/src/plugin.catalog.sync.handler.ts`, `packages/handlers/src/plugin.catalog.browse.ts` |
| MCP registry over HTTP | boundary | `packages/plugins/src/registry/registry-client.ts` | Called live by the catalog sync and browse paths |

## Entry points

- `.` (`src/index.ts`): credentials, OAuth, the entitlement gate and its
  bootstrap, the vault, environments, agent bindings, and the registry
  re-exports.
- `./credentials` (`src/credentials/credential-service.ts`): credential secret
  encryption alone.
- `./registry` (`src/registry/index.ts`): the MCP registry client and catalog
  mapping.
- `./catalog-sync` (`src/catalog-sync.ts`): the catalog upsert.
- `./run-outcomes-policy` (`src/run-outcomes-policy.ts`): read and write the
  run-outcomes consent policy.

## Rules

- Each surface calls `bootstrapEntitlementRuntime()` once at startup. Without
  it, a contract a plugin claims runs whether or not the plugin is installed.
- Entitlement is per workspace. A plugin installed in one workspace does not
  entitle a sibling workspace.
- The gate only fires for a contract some plugin manifest claims. No built-in
  capability pack ships today (ADR-043), so the gate claims nothing until a
  manifest registers (ADR-034).
- The entitlement cache is not invalidated on install, uninstall, or disable.
  A revoked plugin keeps passing the gate for up to 30 seconds, so the gate
  cannot be the only control for an urgent revocation.
- Credential and vault secrets share the `AUTH_TOKEN_ENCRYPTION_KEY` master
  key and carry different key-version labels (`mcp_cred_v1`,
  `workspace_vault_v1`). Without the key, vault writes fail and vault reads
  lock.

## Tests

```bash
pnpm --filter @oxagen/plugins test:unit src/entitlements/entitlement-service.test.ts
```

Tests sit beside their source in each `src/` subdirectory.
