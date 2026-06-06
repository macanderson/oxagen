# Installable Plugins — Plan 3: Spine + Governance + Runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make installed MCP servers actually usable by agents — the org allow-list/denylist governance capabilities, the per-workspace install + credential storage, the polymorphic `PluginType` spine, and the governance-gated `materializeTools` extension that injects enabled servers' tools into every agent.

**Architecture:** A `PluginType` interface (one `contributeTools(ctx)` method) registered per type; MCP is the only fully-implemented type (Integration/Content tools register placeholders that return no tools yet — the extensibility seam). Governance capabilities write `plugin.org_listings` (allow-list, disabled-by-default), `plugin.org_denylist`, and `agent.mcp_servers` (workspace install, now carrying `org_listing_id`). Credentials persist envelope-encrypted in `mcp.credentials`. `materializeTools` joins the allow-list (`enabled`), excludes the denylist, decrypts the credential, and injects tools — so the interactive Q&A agent uses installed servers exactly like Claude Code.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, Zod, `@oxagen/crypto` (already wired in Plan 1's credential service), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§3 spine, §8 governance capabilities, §9 runtime)

**Builds on Plans 1–2 (shipped):** tables + credential service (`@oxagen/plugins/credentials`), catalog (`mcp.catalog_servers`), registry/catalog capabilities. `agent.mcp_servers.org_listing_id` column exists (nullable).

---

## Grounded conventions (verified)

- **`materializeTools(ctx, opts)`** → `{ tools, nameMap }` (`packages/agent/src/runtime/materialize-tools.ts`). The MCP load block (lines 234–261+) queries `withTenantDb` → `schema.mcpServers` filtered `orgId = ctx.orgId AND workspaceId = ctx.workspaceId AND healthStatus = 'healthy'`, then per row `connectMcp({ endpointUrl, authStrategy, authConfig })` + `materializeMcpTools(client, "mcp.${server.id}")`, wrapping each with `authorizeExternalCapability(key, ctx, "allow")` + `insertToolInvocation(...)`. Per-server failures are caught and skipped. **This is the gating point.**
- **`connectMcp(args: { endpointUrl, authStrategy: "none"|"bearer"|"header", authConfig?: Record<string,string> })`** (`packages/agent/src/dispatch/mcp-client.ts`). Bearer → `Authorization: Bearer ${authConfig.token}`. **Inject a decrypted credential by passing `authStrategy: "bearer", authConfig: { token }` — no signature change.**
- **Governance tables are queryable from `@oxagen/agent`** via `@oxagen/database` (`schema.pluginOrgListings`, `schema.pluginOrgDenylist`) — no new dep edge needed for runtime gating.
- **`PluginType` value enum** belongs in `@oxagen/database/src/schema/plugin.ts` (both `@oxagen/agent` and `@oxagen/plugins` depend on `@oxagen/database`; no cycle).
- **Capability wiring** is identical to Plan 2 Task 7 (contract `registerCapability` → handler in `packages/handlers` → api route mirroring `workspace.create.ts` → xmcp tool mirroring `agent.mcp.list.ts` → contract `.test.ts`; register in `packages/handlers/src/register.ts` + `apps/api/src/app.ts`; `pnpm check:manifest`). Management caps: `surfaces:["api","mcp"]`, `scoped:false` (org caps) or `scoped:true` (workspace cap), `defaultRoles:{ org:{ Owner:"allow", Admin:"allow" } }`, `defaultEffect:"deny"`. DB writes use `withSystemDb` for org-level rows (filter by `ctx.orgId`), `withTenantDb` for workspace rows.
- **Existing `agent.mcp.register/list` handlers** stay as workspace-level custom registration; the new `plugin.workspace.set_enabled` is the marketplace install path (writes `agent.mcp_servers.org_listing_id`).

---

## File Structure

- Modify: `packages/database/src/schema/plugin.ts` — add `PluginType` const + type
- Create: `packages/plugins/src/credentials/workspace-credential.ts` (+ `.test.ts`) — set/get encrypted workspace credential against `mcp.credentials`
- Create (per capability) in `packages/oxagen/src/contracts/`, `packages/handlers/src/`, `apps/api/src/routes/v1/`, `apps/mcp/src/tools/`, + contract tests:
  - `plugin.org.install`, `plugin.org.install_bulk`, `plugin.org.uninstall`, `plugin.org.set_enabled`
  - `plugin.denylist.add`, `plugin.denylist.remove`
  - `plugin.workspace.set_enabled`, `plugin.credential.set_secret`
- Modify: `packages/handlers/src/register.ts`, `apps/api/src/app.ts`
- Create: `packages/agent/src/runtime/plugin-type.ts` — `PluginType` interface + registry
- Create: `packages/agent/src/runtime/plugin-types/mcp.ts` — MCP `contributeTools`
- Create: `packages/agent/src/runtime/plugin-types/placeholders.ts` — integration + content_tool no-op contributors (extensibility seam)
- Modify: `packages/agent/src/runtime/materialize-tools.ts` — governance-gated, credential-injecting, type-iterating
- Modify: `packages/agent/package.json` — add `@oxagen/plugins` dep (for credential decrypt in the runtime)

---

## Task 1: `PluginType` value enum

**Files:** Modify `packages/database/src/schema/plugin.ts`

- [ ] **Step 1:** At the top of `plugin.ts` (after imports), add:

```ts
/** The three installable plugin types. The discriminator stored in
 *  plugin.org_listings.plugin_type and used by the runtime PluginType registry. */
export const PLUGIN_TYPES = ["mcp_server", "integration", "content_tool"] as const;
export type PluginType = (typeof PLUGIN_TYPES)[number];
```

- [ ] **Step 2:** Typecheck: `pnpm --filter @oxagen/database typecheck` → PASS.
- [ ] **Step 3:** Commit: `git add packages/database/src/schema/plugin.ts && git commit -m "feat(db): PluginType enum for the installable-plugin spine"`

---

## Task 2: Workspace credential persistence service

**Files:** Create `packages/plugins/src/credentials/workspace-credential.ts` + `.test.ts`; export from `packages/plugins/src/index.ts`.

Stores/loads the per-(workspace × org_listing) credential row in `mcp.credentials`, encrypting via the Plan 1 `credential-service` + `resolveCredentialKms`. Uses `withSystemDb` (the credential row is keyed by org+workspace+listing but the catalog/governance layer operates cross-tenant; RLS still applies via the column values).

- [ ] **Step 1: Write the failing test** `packages/plugins/src/credentials/workspace-credential.test.ts`

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock @oxagen/database so the service is unit-testable without a live DB.
const rows: Record<string, unknown>[] = [];
vi.mock("@oxagen/database", () => ({
  schema: { mcpCredentials: { __table: "mcp.credentials" } },
  withSystemDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
}));
function makeTx() {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ returning: async () => { rows.push(v); return [{ id: "cred-1" }]; } }),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (rows.length ? [rows[rows.length - 1]] : []) }) }) }),
  };
}

beforeEach(() => {
  rows.length = 0;
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
});

describe("workspace-credential", () => {
  it("encrypts a secret on set and decrypts it on get", async () => {
    const { setWorkspaceSecret, getWorkspaceSecret } = await import("./workspace-credential");
    await setWorkspaceSecret({ orgId: "o1", workspaceId: "w1", orgListingId: "l1", authKind: "secret", secret: "sk-xyz" });
    // The stored row must NOT contain plaintext.
    const stored = rows[rows.length - 1]!;
    expect(stored.secretEnc).toBeInstanceOf(Buffer);
    expect(JSON.stringify(stored)).not.toContain("sk-xyz");
    const got = await getWorkspaceSecret({ orgId: "o1", workspaceId: "w1", orgListingId: "l1" });
    expect(got?.secret).toBe("sk-xyz");
  });
});
```

- [ ] **Step 1b:** Run → FAIL (module missing). `pnpm --filter @oxagen/plugins test:unit -- workspace-credential`

- [ ] **Step 2: Create `packages/plugins/src/credentials/workspace-credential.ts`**

```ts
/**
 * Persists per-(workspace × org_listing) plugin credentials in mcp.credentials,
 * envelope-encrypted via the Plan 1 credential service. NEVER logs plaintext.
 */
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { resolveCredentialKms } from "./kms";
import {
  encryptCredentialSecrets,
  decryptCredentialSecrets,
} from "./credential-service";

export interface SetWorkspaceSecretInput {
  orgId: string;
  workspaceId: string;
  orgListingId: string;
  authKind: "oauth" | "secret";
  secret?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  scopes?: string[];
  expiresAt?: Date | null;
}

/** Returns the credential row id. Throws if no encryption key is configured. */
export async function setWorkspaceSecret(input: SetWorkspaceSecretInput): Promise<string> {
  const kms = resolveCredentialKms();
  if (!kms) throw new Error("[plugins] AUTH_TOKEN_ENCRYPTION_KEY required to store credentials");
  const enc = await encryptCredentialSecrets(
    {
      secret: input.secret,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      oauthClientSecret: input.oauthClientSecret,
    },
    kms,
  );
  return withSystemDb(async (tx) => {
    const [row] = await tx
      .insert(schema.mcpCredentials)
      .values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        orgListingId: input.orgListingId,
        authKind: input.authKind,
        secretEnc: enc.secretEnc,
        accessTokenEnc: enc.accessTokenEnc,
        refreshTokenEnc: enc.refreshTokenEnc,
        oauthClientSecretEnc: enc.oauthClientSecretEnc,
        tokenKmsKeyId: enc.tokenKmsKeyId,
        oauthClientId: input.oauthClientId ?? null,
        scopes: input.scopes ?? [],
        expiresAt: input.expiresAt ?? null,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [schema.mcpCredentials.workspaceId, schema.mcpCredentials.orgListingId],
        set: {
          authKind: input.authKind,
          secretEnc: enc.secretEnc,
          accessTokenEnc: enc.accessTokenEnc,
          refreshTokenEnc: enc.refreshTokenEnc,
          oauthClientSecretEnc: enc.oauthClientSecretEnc,
          tokenKmsKeyId: enc.tokenKmsKeyId,
          oauthClientId: input.oauthClientId ?? null,
          scopes: input.scopes ?? [],
          expiresAt: input.expiresAt ?? null,
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.mcpCredentials.id });
    if (!row) throw new Error("[plugins] credential upsert returned no row");
    return row.id;
  });
}

export interface WorkspaceSecret {
  secret: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  oauthClientSecret: string | null;
  authKind: string;
  status: string;
}

/** Loads + decrypts the credential for a (workspace × org_listing), or null. */
export async function getWorkspaceSecret(key: {
  orgId: string;
  workspaceId: string;
  orgListingId: string;
}): Promise<WorkspaceSecret | null> {
  const kms = resolveCredentialKms();
  if (!kms) return null;
  const row = await withSystemDb(async (tx) => {
    const [r] = await tx
      .select()
      .from(schema.mcpCredentials)
      .where(
        and(
          eq(schema.mcpCredentials.workspaceId, key.workspaceId),
          eq(schema.mcpCredentials.orgListingId, key.orgListingId),
        ),
      )
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;
  const dec = await decryptCredentialSecrets(
    {
      tokenKmsKeyId: row.tokenKmsKeyId,
      secretEnc: row.secretEnc,
      accessTokenEnc: row.accessTokenEnc,
      refreshTokenEnc: row.refreshTokenEnc,
      oauthClientSecretEnc: row.oauthClientSecretEnc,
    },
    kms,
  );
  return {
    secret: dec.secret,
    accessToken: dec.accessToken,
    refreshToken: dec.refreshToken,
    oauthClientSecret: dec.oauthClientSecret,
    authKind: row.authKind,
    status: row.status,
  };
}
```

- [ ] **Step 3:** Export from `packages/plugins/src/index.ts`:
```ts
export { setWorkspaceSecret, getWorkspaceSecret } from "./credentials/workspace-credential";
export type { SetWorkspaceSecretInput, WorkspaceSecret } from "./credentials/workspace-credential";
```

- [ ] **Step 4:** Run → PASS; `pnpm --filter @oxagen/plugins typecheck && pnpm --filter @oxagen/plugins test:unit -- workspace-credential`. VERIFY the mock matches the drizzle chain your `withSystemDb` adapter actually calls; adjust the mock if the real chain differs (this test mocks `@oxagen/database`, so keep it in sync with the impl).

- [ ] **Step 5:** Commit: `git add packages/plugins/src/credentials/workspace-credential.ts packages/plugins/src/credentials/workspace-credential.test.ts packages/plugins/src/index.ts && git commit -m "feat(plugins): per-workspace encrypted credential persistence"`

---

## Task 3: `agent.mcp_servers.enabled` column (workspace enable/disable toggle)

The table has `healthStatus` but no `enabled` flag; we need a toggle that survives disable (so config + cached `discoveredTools` aren't lost). Add `enabled boolean NOT NULL DEFAULT true`.

**Files:** Modify `packages/database/src/schema/agent.ts`; create `packages/database/drizzle/0009_mcp_server_enabled.sql`.

- [ ] **Step 1:** In `agent.ts` `mcpServers` table, after `orgListingId`, add:
```ts
    enabled: boolean("enabled").notNull().default(true),
```
(`boolean` is already imported in `agent.ts`.)

- [ ] **Step 2:** Create `packages/database/drizzle/0009_mcp_server_enabled.sql`:
```sql
-- 0009_mcp_server_enabled.sql — workspace enable/disable toggle for installed MCP servers.
ALTER TABLE agent.mcp_servers ADD COLUMN enabled boolean NOT NULL DEFAULT true;
CREATE INDEX mcp_servers_enabled_idx ON agent.mcp_servers (workspace_id, enabled);
```
> VERIFY the next free migration ordinal before writing — if a concurrent `0009_*` already exists on main, bump to `0010_`. Run `ls packages/database/drizzle/*.sql | tail`.

- [ ] **Step 3:** Apply + verify: `DB_MIGRATE_STORES=postgres pnpm db:migrate` then confirm the column via `docker exec -i oxagen-v2-postgres psql -U oxagen -d oxagen -c "\d agent.mcp_servers" | grep enabled`. Typecheck `@oxagen/database`.

- [ ] **Step 4:** Commit: `git add packages/database/src/schema/agent.ts packages/database/drizzle/0009_mcp_server_enabled.sql && git commit -m "feat(db): agent.mcp_servers.enabled workspace toggle"`

---

## Task 4: Governance capabilities (8) — mirror the Plan 2 Task 7 wiring

For EACH capability create the 5 files (contract, contract `.test.ts`, handler, api route, mcp tool) using the EXACT pattern proven in Plan 2 (see committed `packages/oxagen/src/contracts/plugin.catalog.browse.ts` + its handler/route/tool as the reference). Register handlers in `packages/handlers/src/register.ts` and routes in `apps/api/src/app.ts`. Run `pnpm check:manifest` (clean for all `plugin.*`). Common contract fields: `domain:"plugin"`, `mode:"sync"`, `surfaces:["api","mcp"]`, `defaultEffect:"deny"`, `defaultRoles:{ org:{ Owner:"allow", Admin:"allow" }, workspace: {} }`. Handlers use `withSystemDb` for org rows (filter `ctx.orgId`), `withTenantDb` for the workspace row. Guard `.returning()`/index access (strict `noUncheckedIndexedAccess`); no `any`.

### Contracts + handler logic

- [ ] **`plugin.org.install`** (`scoped:false`, sensitivity medium) — input `{ pluginType: z.enum(["mcp_server","integration","content_tool"]).default("mcp_server"), catalogServerId: z.string().optional(), custom: z.object({ name, title?, description?, endpointUrl, transport, authKind: z.enum(["oauth","secret","none"]) }).optional() }` → output `{ orgListingId: z.string() }`.
  Handler: reject if either both or neither of `catalogServerId`/`custom` provided. If `catalogServerId`: load the catalog row (`withSystemDb`), derive `name/title/description/iconUrl` from it, `endpointUrl` = first `remotes[].url` (throw a clear error if the catalog server has no remote — local-only servers aren't installable, per spec §12), `transport` = that remote's type, `authKind` = catalog `authKind`, `source="registry"`. If `custom`: use the provided fields, `source="custom"`. **Reject if the name is on `plugin.org_denylist` for this org+type.** Insert into `pluginOrgListings` with `enabled:false`. Return `{ orgListingId }`.

- [ ] **`plugin.org.install_bulk`** (`scoped:false`, sensitivity medium) — input `{ items: z.array(<same as install input>).min(1).max(50) }` → output `{ installed: z.array(z.object({ catalogServerId: z.string().nullable(), orgListingId: z.string().nullable(), error: z.string().nullable() })) }`. Handler loops, calling the same install logic per item, catching per-item errors into the result (no all-or-nothing). Reuse a shared `installOne(...)` helper imported by both handlers (DRY — put it in `packages/handlers/src/plugin.org.install.ts` and import into the bulk handler).

- [ ] **`plugin.org.uninstall`** (`scoped:false`, sensitivity destructive) — input `{ orgListingId: z.string() }` → `{ ok: z.boolean() }`. Soft-delete the listing (`deletedAt = now`) where `orgId=ctx.orgId`; also delete dependent `agent.mcp_servers` rows (`orgListingId` match) so the runtime drops it. Return ok by affected-rows>0.

- [ ] **`plugin.org.set_enabled`** (`scoped:false`, sensitivity medium) — input `{ orgListingId, enabled: z.boolean() }` → `{ ok }`. Update `pluginOrgListings.enabled` where `orgId=ctx.orgId`.

- [ ] **`plugin.denylist.add`** (`scoped:false`, sensitivity destructive) — input `{ pluginType: z.enum([...]).default("mcp_server"), serverName: z.string(), reason: z.string().optional() }` → `{ ok }`. Insert denylist row (onConflictDoNothing). **Then cascade:** set `pluginOrgListings.enabled=false` (and `deletedAt`? keep listing but disabled) for matching `(orgId, pluginType, name=serverName)`, and delete their `agent.mcp_servers` rows. So a denied server is immediately unusable.

- [ ] **`plugin.denylist.remove`** (`scoped:false`, sensitivity medium) — input `{ serverName: z.string(), pluginType: z.enum([...]).default("mcp_server") }` → `{ ok }`. Delete the denylist row for `orgId+pluginType+serverName`.

- [ ] **`plugin.workspace.set_enabled`** (`scoped:true`, sensitivity medium) — input `{ orgListingId: z.string(), enabled: z.boolean() }` → `{ workspaceServerId: z.string().nullable() }`. **The marketplace install path.** On `enabled:true`: load the org listing (`withSystemDb`, assert `orgId=ctx.orgId`, `enabled=true`, not denylisted, and `endpointUrl` present); upsert an `agent.mcp_servers` row (`withTenantDb`) with `orgId, workspaceId, orgListingId, name, transportType=listing.transport, endpointUrl=listing.endpointUrl, authStrategy` (map: authKind `secret`→`bearer` if a header token, else `header`; `none`→`none`; `oauth`→`bearer`), `authConfig={}` (the real secret is injected at runtime from `mcp.credentials`), `healthStatus="unknown"`, `enabled:true`, `discoveredTools:[]`. Return `{ workspaceServerId: publicId }`. On `enabled:false`: set `agent.mcp_servers.enabled=false` where `workspaceId=ctx.workspaceId AND orgListingId=...`. (Unique target for upsert: `(workspaceId, orgListingId)` — add a `uniqueIndex` on `agent.mcp_servers (workspace_id, org_listing_id)` in the Task 3 migration to support `onConflictDoUpdate`.)

- [ ] **`plugin.credential.set_secret`** (`scoped:true`, sensitivity high) — input `{ orgListingId: z.string(), authKind: z.enum(["oauth","secret"]), secret: z.string().optional(), accessToken: z.string().optional(), refreshToken: z.string().optional() }` → `{ ok }`. Calls `setWorkspaceSecret({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, orgListingId, ... })` from `@oxagen/plugins`. (Add `@oxagen/plugins` to `packages/handlers/package.json` deps + install.)

- [ ] **Final:** register all 8 handlers + routes; `pnpm check:manifest` clean; `pnpm --filter @oxagen/oxagen --filter @oxagen/handlers --filter @oxagen/api --filter @oxagen/mcp typecheck`; `pnpm --filter @oxagen/oxagen test:unit -- plugin`. Commit: `feat(plugins): org allow-list/denylist + workspace install/enable + credential capabilities`.

> Update Task 3's migration to also add: `CREATE UNIQUE INDEX mcp_servers_ws_listing_uniq ON agent.mcp_servers (workspace_id, org_listing_id) WHERE org_listing_id IS NOT NULL;` (partial unique so legacy custom rows with NULL org_listing_id are unaffected). The Drizzle schema gets a matching `uniqueIndex(...).where(sql\`org_listing_id IS NOT NULL\`)`.

---

## Task 5: `PluginType` spine + MCP contributor + placeholders

**Files:** Create `packages/agent/src/runtime/plugin-type.ts`, `packages/agent/src/runtime/plugin-types/mcp.ts`, `packages/agent/src/runtime/plugin-types/placeholders.ts`; modify `packages/agent/package.json` (add `@oxagen/plugins`).

- [ ] **Step 1: `packages/agent/src/runtime/plugin-type.ts`** — the interface + registry:

```ts
import type { CapabilityContext } from "@oxagen/oxagen/types";
import type { Tool } from "ai"; // VERIFY the ToolSet/Tool type the runtime already uses (see materialize-tools imports)
import type { PluginType as PluginTypeName } from "@oxagen/database";

/** A contributed tool plus the real (dotted) capability name for the nameMap. */
export interface ContributedTool {
  realName: string;
  tool: Tool;
}

/** One installable-plugin type. contributeTools yields the agent tools for all
 *  enabled, non-denied, installed plugins of this type in the given context. */
export interface PluginTypeContributor {
  type: PluginTypeName;
  contributeTools(ctx: CapabilityContext): Promise<ContributedTool[]>;
}

const registry = new Map<PluginTypeName, PluginTypeContributor>();
export function registerPluginType(c: PluginTypeContributor): void {
  registry.set(c.type, c);
}
export function getPluginTypeContributors(): PluginTypeContributor[] {
  return [...registry.values()];
}
```

- [ ] **Step 2: `plugin-types/mcp.ts`** — the MCP contributor. Move the existing MCP load logic here, governance-gated + credential-injected:

```ts
import { and, eq, inArray, isNull, not } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { getWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { connectMcp, materializeMcpTools } from "../../dispatch/mcp-client";
import { registerPluginType, type ContributedTool } from "../plugin-type";

async function contributeMcpTools(ctx: CapabilityContext): Promise<ContributedTool[]> {
  if (!ctx.workspaceId) return [];
  // Enabled, healthy installs joined to an enabled org listing, excluding denylisted names.
  const rows = await withTenantDb(async (tx) => {
    const denied = tx
      .select({ name: schema.pluginOrgDenylist.serverName })
      .from(schema.pluginOrgDenylist)
      .where(eq(schema.pluginOrgDenylist.orgId, ctx.orgId));
    return tx
      .select({
        id: schema.mcpServers.id,
        name: schema.mcpServers.name,
        endpointUrl: schema.mcpServers.endpointUrl,
        authStrategy: schema.mcpServers.authStrategy,
        orgListingId: schema.mcpServers.orgListingId,
      })
      .from(schema.mcpServers)
      .innerJoin(schema.pluginOrgListings, eq(schema.mcpServers.orgListingId, schema.pluginOrgListings.id))
      .where(
        and(
          eq(schema.mcpServers.orgId, ctx.orgId),
          eq(schema.mcpServers.workspaceId, ctx.workspaceId),
          eq(schema.mcpServers.enabled, true),
          eq(schema.mcpServers.healthStatus, "healthy"),
          eq(schema.pluginOrgListings.enabled, true),
          isNull(schema.pluginOrgListings.deletedAt),
          not(inArray(schema.mcpServers.name, denied)),
        ),
      );
  });

  const out: ContributedTool[] = [];
  for (const server of rows) {
    try {
      let authStrategy = server.authStrategy as "none" | "bearer" | "header";
      let authConfig: Record<string, string> = {};
      if (server.orgListingId && authStrategy !== "none") {
        const cred = await getWorkspaceSecret({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          orgListingId: server.orgListingId,
        });
        const token = cred?.accessToken ?? cred?.secret ?? null;
        if (token) {
          authStrategy = "bearer";
          authConfig = { token };
        }
      }
      const client = await connectMcp({ endpointUrl: server.endpointUrl, authStrategy, authConfig });
      const tools = await materializeMcpTools(client, `mcp.${server.id}`);
      for (const [realName, tool] of Object.entries(tools)) out.push({ realName, tool });
    } catch (err) {
      console.error(`[plugin-types/mcp] server ${server.id} failed:`, err);
    }
  }
  return out;
}

registerPluginType({ type: "mcp_server", contributeTools: contributeMcpTools });
export { contributeMcpTools };
```
> VERIFY: `not(inArray(col, subquery))` — confirm drizzle 0.45.2 supports a subquery in `inArray`; if not, fetch denied names first into a `string[]` and use `notInArray(col, names)` (handle the empty-array case). Also VERIFY the exact `Tool`/`ToolSet` types + the `insertToolInvocation`/`authorizeExternalCapability` wrapping in the current `materialize-tools.ts` and preserve that wrapping (move it into this contributor so behavior is unchanged).

- [ ] **Step 3: `plugin-types/placeholders.ts`** — extensibility seam (no tools yet):
```ts
import { registerPluginType } from "../plugin-type";
// Integration (ontology ingestion) + Content tool (Drive/Workspace/Excel) verticals
// are Linear epics; they register here so the marketplace + governance treat them as
// first-class types now, and deepening them later means filling in contributeTools only.
registerPluginType({ type: "integration", contributeTools: async () => [] });
registerPluginType({ type: "content_tool", contributeTools: async () => [] });
```

- [ ] **Step 4:** Add `"@oxagen/plugins": "workspace:*"` to `packages/agent/package.json`; `pnpm install --no-frozen-lockfile`. Typecheck `@oxagen/agent`. Commit: `feat(agent): PluginType spine + governance-gated MCP contributor + placeholders`.

---

## Task 6: Wire `materializeTools` to the spine

**Files:** Modify `packages/agent/src/runtime/materialize-tools.ts`.

- [ ] **Step 1:** Import the spine + the type modules (so their `registerPluginType` side-effects run):
```ts
import { getPluginTypeContributors } from "./plugin-type";
import "./plugin-types/mcp";
import "./plugin-types/placeholders";
```

- [ ] **Step 2:** DELETE the old inline MCP load block (the `if (ctx.workspaceId) { ... mcpServerRows ... }` section, ~lines 234–end-of-loop) and REPLACE with a loop over contributors that reuses the existing `register(realName, tool)` helper:
```ts
for (const contributor of getPluginTypeContributors()) {
  let contributed: Awaited<ReturnType<typeof contributor.contributeTools>> = [];
  try {
    contributed = await contributor.contributeTools(ctx);
  } catch (err) {
    console.error(`[materialize-tools] plugin type ${contributor.type} failed:`, err);
  }
  for (const { realName, tool } of contributed) register(realName, tool);
}
```
> VERIFY: preserve the `authorizeExternalCapability` + `insertToolInvocation` wrapping that the old block applied per MCP tool — either keep it in `materializeMcpTools`/the contributor, or wrap inside `register`. The net behavior (IAM gate + invocation logging per external tool) MUST be identical to before. Read the old block carefully before deleting and carry every side effect over.

- [ ] **Step 3:** Typecheck `@oxagen/agent`; run the agent package's existing tests (`pnpm --filter @oxagen/agent test:unit`) to confirm no regression. Commit: `feat(agent): materializeTools injects tools via the PluginType registry (governance-gated)`.

---

## Task 7: Verification

- [ ] `pnpm check:manifest` — clean for all `plugin.*`.
- [ ] Typecheck: `pnpm --filter @oxagen/plugins --filter @oxagen/oxagen --filter @oxagen/handlers --filter @oxagen/agent --filter @oxagen/api --filter @oxagen/mcp typecheck` — all PASS.
- [ ] Tests: `pnpm --filter @oxagen/plugins test:unit` + `pnpm --filter @oxagen/oxagen test:unit -- plugin` + `pnpm --filter @oxagen/agent test:unit` — all green.
- [ ] Lint touched packages.
- [ ] **Live smoke** (local PG + a fixture MCP server, optional): install a catalog server to the org, enable at a workspace, set a secret, then call `materializeTools(ctx)` and assert the server's tools appear; flip the org listing `enabled=false` and assert they vanish; denylist the name and assert they vanish. Document; don't commit throwaway.

## Done criteria for Plan 3

- Org admins can install (single + bulk) catalog/custom servers to the org allow-list (disabled by default), enable/disable, uninstall, and maintain a denylist that immediately disables matching installs.
- Workspaces enable servers from the allow-list only; per-workspace secrets persist encrypted.
- `materializeTools` injects ONLY enabled + healthy + allow-listed + non-denied servers' tools, with the decrypted credential, via the polymorphic `PluginType` registry — so the interactive Q&A agent uses them. Integration/Content-tool types are registered placeholders (extensible, no tools yet).

**Next plan:** `2026-06-06-installable-plugins-04-oauth.md` — MCP OAuth 2.1 (discovery/DCR/PKCE/refresh) + the re-auth state machine.

