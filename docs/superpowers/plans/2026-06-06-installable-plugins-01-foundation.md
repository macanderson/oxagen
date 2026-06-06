# Installable Plugins — Plan 1: Foundation (schema + credential service)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the data foundation for the installable-plugins feature — the Postgres schemas/tables for registries, catalog, org governance, workspace install, encrypted credentials, and notifications — plus a SOC2-compliant credential-encryption service in a new `@oxagen/plugins` package.

**Architecture:** New `mcp` and `plugin` Postgres schema namespaces (Drizzle `pgSchema`), tables built from the existing `_mixins` (`idMixin`/`auditMixin`/`softDeleteMixin`/`orgScopeMixin`), a hand-written forward SQL migration `0008_installable_plugins.sql` applied by `pnpm db:migrate`, the existing `agent.mcp_servers` table repurposed as the workspace-install row, and a credential service that envelope-encrypts OAuth/secret tokens via `@oxagen/crypto` (AES-256-GCM + local KMS adapter), modeled on `packages/auth/src/token-encryption.ts`.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, `@oxagen/crypto` (envelope encryption), Vitest 2.1.9, hand-written SQL migrations, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§4 data model, §6 auth, §2 existing primitives).

---

## File Structure

**New package `@oxagen/plugins`** (`packages/plugins/`) — home of the credential service now; the `PluginType` spine lands here in Plan 3.
- Create: `packages/plugins/package.json`
- Create: `packages/plugins/tsconfig.json`
- Create: `packages/plugins/vitest.config.ts`
- Create: `packages/plugins/src/index.ts` — public barrel
- Create: `packages/plugins/src/credentials/kms.ts` — resolves the KMS adapter from env
- Create: `packages/plugins/src/credentials/credential-service.ts` — encrypt/decrypt a credential record
- Create: `packages/plugins/src/credentials/credential-service.test.ts` — round-trip unit tests

**Database schema** (`packages/database/`)
- Modify: `packages/database/src/schema/_schemas.ts` — add `mcpSchema`, `pluginSchema`, `notificationSchema`
- Create: `packages/database/src/schema/mcp.ts` — `mcp.registries`, `mcp.catalog_servers`, `mcp.credentials`
- Create: `packages/database/src/schema/plugin.ts` — `plugin.org_listings`, `plugin.org_denylist`
- Create: `packages/database/src/schema/notification.ts` — `notification.notifications`
- Modify: `packages/database/src/schema/agent.ts:260-278` — add `orgListingId` to `mcpServers`
- Modify: `packages/database/src/schema/index.ts` — re-export the new schema modules
- Create: `packages/database/drizzle/0008_installable_plugins.sql` — forward migration (schemas, tables, indexes, default-registry seed)

**Conventions to follow (verified):**
- `idMixin("prefix")` → `id uuid PK` (uuidv7) + `public_id citext UNIQUE` auto-prefixed.
- `auditMixin()` / `softDeleteMixin()` / `orgScopeMixin()` from `_mixins.ts`.
- FK columns are bare `uuid("x").notNull()` in Drizzle; actual FK constraints live in the SQL migration.
- `bytea("col")` from `@oxagen/crypto/drizzle` for encrypted columns.
- Migrations are hand-written, numbered, immutable after merge (next is `0007_`). Applied by `tools/scripts/db-migrate.ts`, tracked in `public._migrations`.

---

## Task 1: Scaffold the `@oxagen/plugins` package

**Files:**
- Create: `packages/plugins/package.json`
- Create: `packages/plugins/tsconfig.json`
- Create: `packages/plugins/vitest.config.ts`
- Create: `packages/plugins/src/index.ts`

- [ ] **Step 1: Create `packages/plugins/package.json`**

```json
{
  "name": "@oxagen/plugins",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./credentials": "./src/credentials/credential-service.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --max-warnings 0",
    "test:unit": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@oxagen/config": "workspace:*",
    "@oxagen/crypto": "workspace:*",
    "zod": "3.25.76"
  },
  "devDependencies": {
    "@types/node": "25.9.1",
    "typescript": "6.0.3",
    "@vitest/coverage-v8": "2.1.9",
    "vitest": "2.1.9"
  }
}
```

- [ ] **Step 2: Create `packages/plugins/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/plugins/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `packages/plugins/src/index.ts` (temporary placeholder barrel)**

```ts
// @oxagen/plugins — installable-plugin spine.
// Plan 1 ships the credential service; the PluginType spine lands in Plan 3.
export {
  encryptCredentialSecrets,
  decryptCredentialSecrets,
  MCP_CREDENTIAL_KEY_ID,
} from "./credentials/credential-service";
export type {
  CredentialPlaintext,
  CredentialCiphertext,
} from "./credentials/credential-service";
```

- [ ] **Step 5: Install workspace deps so the new package links**

Run: `pnpm install`
Expected: completes; `@oxagen/plugins` appears in the workspace (no lockfile errors).

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/package.json packages/plugins/tsconfig.json packages/plugins/vitest.config.ts packages/plugins/src/index.ts pnpm-lock.yaml
git commit -m "chore(plugins): scaffold @oxagen/plugins package"
```

---

## Task 2: Add the `mcp`, `plugin`, `notification` pg-schema namespaces

**Files:**
- Modify: `packages/database/src/schema/_schemas.ts`

- [ ] **Step 1: Add three `pgSchema` exports to `_schemas.ts`**

Append after the existing `securitySchema` line (after line 20):

```ts
export const mcpSchema = pgSchema("mcp");
export const pluginSchema = pgSchema("plugin");
export const notificationSchema = pgSchema("notification");
```

- [ ] **Step 2: Typecheck the database package**

Run: `pnpm --filter @oxagen/database typecheck`
Expected: PASS (no usages yet, just new exports).

- [ ] **Step 3: Commit**

```bash
git add packages/database/src/schema/_schemas.ts
git commit -m "feat(db): add mcp, plugin, notification schema namespaces"
```

---

## Task 3: Drizzle tables — `mcp.registries` and `mcp.catalog_servers`

**Files:**
- Create: `packages/database/src/schema/mcp.ts`

- [ ] **Step 1: Create `packages/database/src/schema/mcp.ts` with the two catalog tables**

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mcpSchema } from "./_schemas";
import { auditMixin, bytea, idMixin, orgScopeMixin } from "./_mixins";

/**
 * mcp.registries — registry sources an org can sync from. A row with a NULL
 * org_id is a global default seed visible to every org (the official MCP
 * registry is seeded this way in migration 0007).
 */
export const mcpRegistries = mcpSchema.table(
  "registries",
  {
    ...idMixin("mreg"),
    ...auditMixin(),
    orgId: uuid("org_id"), // NULL ⇒ global default seed
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    isDefaultSeed: boolean("is_default_seed").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    lastSyncedCursor: text("last_synced_cursor"),
  },
  (t) => ({
    orgIdx: index("registries_org_idx").on(t.orgId),
  }),
);

/**
 * mcp.catalog_servers — cached registry records. One row per
 * (registry_id, name, version); is_latest is maintained on upsert.
 * Heterogeneous registry payloads (repository/icons/packages/remotes/meta)
 * are stored as JSONB; transport_types/categories are denormalized arrays for
 * cheap filtering.
 */
export const mcpCatalogServers = mcpSchema.table(
  "catalog_servers",
  {
    ...idMixin("mcat"),
    ...auditMixin(),
    registryId: uuid("registry_id").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    isLatest: boolean("is_latest").notNull().default(false),
    title: text("title"),
    description: text("description").notNull(),
    repository: jsonb("repository"),
    websiteUrl: text("website_url"),
    icons: jsonb("icons").notNull().default(sql`'[]'::jsonb`),
    packages: jsonb("packages").notNull().default(sql`'[]'::jsonb`),
    remotes: jsonb("remotes").notNull().default(sql`'[]'::jsonb`),
    transportTypes: text("transport_types").array().notNull().default(sql`'{}'::text[]`),
    authKind: text("auth_kind").notNull(),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    readmeHtml: text("readme_html"),
    readmeFetchedAt: timestamp("readme_fetched_at", { withTimezone: true, mode: "date" }),
    status: text("status").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    upstreamUpdatedAt: timestamp("upstream_updated_at", { withTimezone: true, mode: "date" }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true, mode: "date" }),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    uniqueVersion: uniqueIndex("catalog_servers_name_version_uniq").on(
      t.registryId,
      t.name,
      t.version,
    ),
    registryNameIdx: index("catalog_servers_registry_name_idx").on(t.registryId, t.name),
  }),
);

/**
 * mcp.credentials — SOC2-encrypted auth per (org_listing × workspace).
 * Token columns are envelope-encrypted bytea (AES-256-GCM); the service layer
 * (@oxagen/plugins/credentials) is responsible for encrypt/decrypt. Org-level
 * shared credentials use the ORG_ONLY_WS sentinel workspace id.
 */
export const mcpCredentials = mcpSchema.table(
  "credentials",
  {
    ...idMixin("mcrd"),
    ...auditMixin(),
    ...orgScopeMixin(),
    orgListingId: uuid("org_listing_id").notNull(),
    authKind: text("auth_kind").notNull(), // oauth | secret
    accessTokenEnc: bytea("access_token_enc"),
    refreshTokenEnc: bytea("refresh_token_enc"),
    secretEnc: bytea("secret_enc"),
    oauthClientSecretEnc: bytea("oauth_client_secret_enc"),
    tokenKmsKeyId: text("token_kms_key_id"),
    oauthClientId: text("oauth_client_id"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    status: text("status").notNull().default("active"), // active | needs_reauth | revoked
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    uniqueListingWs: uniqueIndex("credentials_workspace_listing_uniq").on(
      t.workspaceId,
      t.orgListingId,
    ),
    orgIdx: index("credentials_org_idx").on(t.orgId),
  }),
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @oxagen/database typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/database/src/schema/mcp.ts
git commit -m "feat(db): mcp registries, catalog_servers, credentials tables"
```

---

## Task 4: Drizzle tables — `plugin.org_listings` and `plugin.org_denylist`

**Files:**
- Create: `packages/database/src/schema/plugin.ts`

- [ ] **Step 1: Create `packages/database/src/schema/plugin.ts`**

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pluginSchema } from "./_schemas";
import { auditMixin, idMixin, softDeleteMixin } from "./_mixins";

/**
 * plugin.org_listings — the org allow-list. Polymorphic across plugin types
 * (mcp_server | integration | content_tool). A row with catalog_server_id set
 * came from a registry; NULL means a custom admin-added plugin. Newly added
 * listings are disabled by default but available to all child workspaces.
 */
export const pluginOrgListings = pluginSchema.table(
  "org_listings",
  {
    ...idMixin("porg"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id").notNull(),
    pluginType: text("plugin_type").notNull(), // mcp_server | integration | content_tool
    catalogServerId: uuid("catalog_server_id"), // NULL ⇒ custom
    source: text("source").notNull(), // registry | custom
    name: text("name").notNull(),
    title: text("title"),
    description: text("description"),
    iconUrl: text("icon_url"),
    endpointUrl: text("endpoint_url"),
    transport: text("transport"),
    authKind: text("auth_kind").notNull(), // oauth | secret | none
    authConfig: jsonb("auth_config").notNull().default(sql`'{}'::jsonb`),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    uniqueName: uniqueIndex("org_listings_org_type_name_uniq").on(
      t.orgId,
      t.pluginType,
      t.name,
    ),
    orgTypeIdx: index("org_listings_org_type_idx").on(t.orgId, t.pluginType),
  }),
);

/**
 * plugin.org_denylist — servers an org admin has blocked. A denylisted name is
 * non-installable; the marketplace still shows it with a disabled/denied
 * treatment. Adding a denylist row disables any existing listing/install for
 * that name (enforced in the handler, Plan 3).
 */
export const pluginOrgDenylist = pluginSchema.table(
  "org_denylist",
  {
    ...idMixin("pden"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    pluginType: text("plugin_type").notNull(),
    serverName: text("server_name").notNull(),
    reason: text("reason"),
  },
  (t) => ({
    uniqueName: uniqueIndex("org_denylist_org_type_name_uniq").on(
      t.orgId,
      t.pluginType,
      t.serverName,
    ),
  }),
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @oxagen/database typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/database/src/schema/plugin.ts
git commit -m "feat(db): plugin org_listings + org_denylist tables"
```

---

## Task 5: Drizzle table — `notification.notifications`

**Files:**
- Create: `packages/database/src/schema/notification.ts`

- [ ] **Step 1: Create `packages/database/src/schema/notification.ts`**

```ts
import {
  boolean,
  index,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { notificationSchema } from "./_schemas";
import { auditMixin, idMixin } from "./_mixins";

/**
 * notification.notifications — in-app notification feed (also mirrored to email
 * for certain kinds). The MCP re-auth flow (Plan 5) is the first producer; the
 * table is generic so approval/run/security kinds can reuse it.
 */
export const notifications = notificationSchema.table(
  "notifications",
  {
    ...idMixin("ntf"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id"),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull(), // system | approval | run | member | security
    title: text("title").notNull(),
    body: text("body"),
    deepLink: text("deep_link"),
    unread: boolean("unread").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    emailedAt: timestamp("emailed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    userUnreadIdx: index("notifications_user_unread_idx").on(t.userId, t.unread),
    orgIdx: index("notifications_org_idx").on(t.orgId),
  }),
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @oxagen/database typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/database/src/schema/notification.ts
git commit -m "feat(db): notifications table"
```

---

## Task 6: Repurpose `agent.mcp_servers` as the workspace-install row

**Files:**
- Modify: `packages/database/src/schema/agent.ts:260-278`
- Modify: `packages/database/src/schema/index.ts`

- [ ] **Step 1: Add `orgListingId` to the `mcpServers` table in `agent.ts`**

In `packages/database/src/schema/agent.ts`, inside the `mcpServers` table object (after the `...orgScopeMixin(),` line at 265), add:

```ts
    orgListingId: uuid("org_listing_id"),
```

Place it immediately before `name: text("name").notNull(),`. (Nullable for now — the migration backfills nothing because there are no production rows; Plan 3 makes the handler require it on insert.) Confirm `uuid` is already imported in `agent.ts` (it is — the table uses `uuid` via the mixins; if the named import is missing, add `uuid` to the `drizzle-orm/pg-core` import).

- [ ] **Step 2: Re-export the new schema modules from the schema barrel**

In `packages/database/src/schema/index.ts`, add (matching the existing export style in that file):

```ts
export * from "./mcp";
export * from "./plugin";
export * from "./notification";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @oxagen/database typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/database/src/schema/agent.ts packages/database/src/schema/index.ts
git commit -m "feat(db): wire org_listing into mcp_servers + export new schemas"
```

---

## Task 7: Forward migration `0008_installable_plugins.sql`

**Files:**
- Create: `packages/database/drizzle/0008_installable_plugins.sql`

- [ ] **Step 1: Create the migration file with schemas, tables, indexes, and the default-registry seed**

`packages/database/drizzle/0008_installable_plugins.sql`:

```sql
-- 0008_installable_plugins.sql
-- Installable plugins foundation: registries, catalog, org governance,
-- workspace install link, encrypted credentials, notifications.
-- Forward migration (immutable after merge). See spec
-- docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md §4.

CREATE SCHEMA IF NOT EXISTS mcp;
CREATE SCHEMA IF NOT EXISTS plugin;
CREATE SCHEMA IF NOT EXISTS notification;

-- ---------------------------------------------------------------------------
-- mcp.registries
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.registries (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid,
  name               text NOT NULL,
  base_url           text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  is_default_seed    boolean NOT NULL DEFAULT false,
  last_synced_at     timestamptz,
  last_synced_cursor text
);
CREATE INDEX registries_org_idx ON mcp.registries (org_id);
CREATE UNIQUE INDEX registries_org_baseurl_uniq ON mcp.registries (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), base_url);

-- ---------------------------------------------------------------------------
-- mcp.catalog_servers
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.catalog_servers (
  id                  uuid PRIMARY KEY DEFAULT COALESCE(
                        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                        uuid_generate_v4()),
  public_id           citext NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid,
  updated_by_user_id  uuid,
  registry_id         uuid NOT NULL REFERENCES mcp.registries(id) ON DELETE CASCADE,
  name                text NOT NULL,
  version             text NOT NULL,
  is_latest           boolean NOT NULL DEFAULT false,
  title               text,
  description         text NOT NULL,
  repository          jsonb,
  website_url         text,
  icons               jsonb NOT NULL DEFAULT '[]'::jsonb,
  packages            jsonb NOT NULL DEFAULT '[]'::jsonb,
  remotes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  transport_types     text[] NOT NULL DEFAULT '{}'::text[],
  auth_kind           text NOT NULL,
  categories          text[] NOT NULL DEFAULT '{}'::text[],
  readme_html         text,
  readme_fetched_at   timestamptz,
  status              text NOT NULL,
  published_at        timestamptz,
  upstream_updated_at timestamptz,
  status_changed_at   timestamptz,
  meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT catalog_servers_status_chk CHECK (status IN ('active','deprecated','deleted')),
  CONSTRAINT catalog_servers_auth_kind_chk CHECK (auth_kind IN ('oauth','secret','none'))
);
CREATE UNIQUE INDEX catalog_servers_name_version_uniq ON mcp.catalog_servers (registry_id, name, version);
CREATE INDEX catalog_servers_registry_name_idx ON mcp.catalog_servers (registry_id, name);
CREATE INDEX catalog_servers_categories_gin ON mcp.catalog_servers USING gin (categories);
CREATE INDEX catalog_servers_transport_gin ON mcp.catalog_servers USING gin (transport_types);

-- ---------------------------------------------------------------------------
-- plugin.org_listings
-- ---------------------------------------------------------------------------
CREATE TABLE plugin.org_listings (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  org_id             uuid NOT NULL,
  plugin_type        text NOT NULL,
  catalog_server_id  uuid REFERENCES mcp.catalog_servers(id) ON DELETE SET NULL,
  source             text NOT NULL,
  name               text NOT NULL,
  title              text,
  description        text,
  icon_url           text,
  endpoint_url       text,
  transport          text,
  auth_kind          text NOT NULL,
  auth_config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled            boolean NOT NULL DEFAULT false,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT org_listings_type_chk CHECK (plugin_type IN ('mcp_server','integration','content_tool')),
  CONSTRAINT org_listings_source_chk CHECK (source IN ('registry','custom')),
  CONSTRAINT org_listings_auth_kind_chk CHECK (auth_kind IN ('oauth','secret','none'))
);
CREATE UNIQUE INDEX org_listings_org_type_name_uniq ON plugin.org_listings (org_id, plugin_type, name);
CREATE INDEX org_listings_org_type_idx ON plugin.org_listings (org_id, plugin_type);

-- ---------------------------------------------------------------------------
-- plugin.org_denylist
-- ---------------------------------------------------------------------------
CREATE TABLE plugin.org_denylist (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  plugin_type        text NOT NULL,
  server_name        text NOT NULL,
  reason             text,
  CONSTRAINT org_denylist_type_chk CHECK (plugin_type IN ('mcp_server','integration','content_tool'))
);
CREATE UNIQUE INDEX org_denylist_org_type_name_uniq ON plugin.org_denylist (org_id, plugin_type, server_name);

-- ---------------------------------------------------------------------------
-- mcp.credentials  (SOC2 encrypted)
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.credentials (
  id                      uuid PRIMARY KEY DEFAULT COALESCE(
                            CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                              THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                            uuid_generate_v4()),
  public_id               citext NOT NULL UNIQUE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by_user_id      uuid,
  updated_by_user_id      uuid,
  org_id                  uuid NOT NULL,
  workspace_id            uuid NOT NULL,
  org_listing_id          uuid NOT NULL REFERENCES plugin.org_listings(id) ON DELETE CASCADE,
  auth_kind               text NOT NULL,
  access_token_enc        bytea,
  refresh_token_enc       bytea,
  secret_enc              bytea,
  oauth_client_secret_enc bytea,
  token_kms_key_id        text,
  oauth_client_id         text,
  scopes                  text[] NOT NULL DEFAULT '{}'::text[],
  expires_at              timestamptz,
  status                  text NOT NULL DEFAULT 'active',
  last_refreshed_at       timestamptz,
  CONSTRAINT credentials_auth_kind_chk CHECK (auth_kind IN ('oauth','secret')),
  CONSTRAINT credentials_status_chk CHECK (status IN ('active','needs_reauth','revoked'))
);
CREATE UNIQUE INDEX credentials_workspace_listing_uniq ON mcp.credentials (workspace_id, org_listing_id);
CREATE INDEX credentials_org_idx ON mcp.credentials (org_id);

-- ---------------------------------------------------------------------------
-- agent.mcp_servers — add org_listing_id link
-- ---------------------------------------------------------------------------
ALTER TABLE agent.mcp_servers ADD COLUMN org_listing_id uuid REFERENCES plugin.org_listings(id) ON DELETE CASCADE;
CREATE INDEX mcp_servers_org_listing_idx ON agent.mcp_servers (org_listing_id);

-- ---------------------------------------------------------------------------
-- notification.notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notification.notifications (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  workspace_id       uuid,
  user_id            uuid NOT NULL,
  kind               text NOT NULL,
  title              text NOT NULL,
  body               text,
  deep_link          text,
  unread             boolean NOT NULL DEFAULT true,
  archived           boolean NOT NULL DEFAULT false,
  emailed_at         timestamptz,
  CONSTRAINT notifications_kind_chk CHECK (kind IN ('system','approval','run','member','security'))
);
CREATE INDEX notifications_user_unread_idx ON notification.notifications (user_id, unread);
CREATE INDEX notifications_org_idx ON notification.notifications (org_id);

-- ---------------------------------------------------------------------------
-- Seed: the official public MCP registry, enabled by default for every org
-- (org_id NULL ⇒ global default seed).
-- ---------------------------------------------------------------------------
INSERT INTO mcp.registries (public_id, org_id, name, base_url, enabled, is_default_seed)
VALUES (
  'mreg_' || lower(translate(encode(gen_random_bytes(14), 'base32'), '=', '')),
  NULL,
  'Official MCP Registry',
  'https://registry.modelcontextprotocol.io',
  true,
  true
);
```

> Note on the seed `public_id`: it is generated inline so the row is self-contained. If `gen_random_bytes`/`base32` is unavailable in the target Postgres, replace the VALUES `public_id` expression with a literal `'mreg_officialmcpreg0000'` — it only needs to be unique and prefixed.

- [ ] **Step 2: Verify the SQL parses against the schema dialect (dry inspection)**

Run: `grep -c "CREATE TABLE" packages/database/drizzle/0008_installable_plugins.sql`
Expected: `6`

- [ ] **Step 3: Commit**

```bash
git add packages/database/drizzle/0008_installable_plugins.sql
git commit -m "feat(db): 0007 installable plugins migration + default registry seed"
```

---

## Task 8: Apply the migration to local Postgres and verify

**Files:** none (runtime verification)

- [ ] **Step 1: Ensure the local dev stack is up**

Run: `lsof -ti:5433 >/dev/null && echo "pg up" || echo "run pnpm dev first"`
Expected: `pg up`. If not, start the stack (`pnpm dev` brings up Docker + local Postgres on :5433) before continuing.

- [ ] **Step 2: Apply only the Postgres migrations**

Run: `DB_MIGRATE_STORES=postgres pnpm db:migrate`
Expected: log shows `0008_installable_plugins.sql` applied; exit 0.

- [ ] **Step 3: Verify the tables and seed exist**

Run:
```bash
psql "postgres://oxagen:oxagen@localhost:5433/oxagen" -c "\dt mcp.*" -c "\dt plugin.*" -c "\dt notification.*" -c "SELECT name, base_url, is_default_seed FROM mcp.registries WHERE is_default_seed;"
```
(Use the local connection string from `.env.local` if the credentials differ.)
Expected: lists `mcp.registries`, `mcp.catalog_servers`, `mcp.credentials`, `plugin.org_listings`, `plugin.org_denylist`, `notification.notifications`; the SELECT returns one row for `https://registry.modelcontextprotocol.io` with `is_default_seed = t`.

- [ ] **Step 4: Verify the `agent.mcp_servers` column was added**

Run: `psql "postgres://oxagen:oxagen@localhost:5433/oxagen" -c "\d agent.mcp_servers" | grep org_listing_id`
Expected: a line showing `org_listing_id | uuid`.

- [ ] **Step 5: Commit (no file changes; record verification in the task log only)**

No commit — this task is verification. If `_migrations` tracking produced any committed artifact, do not commit it.

---

## Task 9: Credential KMS adapter resolver

**Files:**
- Create: `packages/plugins/src/credentials/kms.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/src/credentials/kms.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolveCredentialKms } from "./kms";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("resolveCredentialKms", () => {
  const prev = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.AUTH_TOKEN_ENCRYPTION_KEY = prev;
  });

  it("returns null when no key is configured", () => {
    expect(resolveCredentialKms()).toBeNull();
  });

  it("returns an adapter when a valid key is configured", () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = VALID_KEY;
    const kms = resolveCredentialKms();
    expect(kms).not.toBeNull();
    expect(typeof kms!.adapter.generateDataKey).toBe("function");
    expect(kms!.keyId).toBe("mcp_cred_v1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- kms`
Expected: FAIL with "Cannot find module './kms'" (or `resolveCredentialKms is not a function`).

- [ ] **Step 3: Write `packages/plugins/src/credentials/kms.ts`**

```ts
/**
 * Resolves the KMS adapter used to envelope-encrypt plugin credentials.
 *
 * Mirrors packages/auth/src/auth.ts: the local KEK adapter sources its master
 * key from AUTH_TOKEN_ENCRYPTION_KEY (base64 256-bit). When the key is absent
 * (local dev / tests without secrets), this returns null and the caller stores
 * no ciphertext — exactly as the auth package degrades. NEVER log key material.
 */
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { KmsAdapter } from "@oxagen/crypto";

/** Stable per-row key-version label; bump for rotation. */
export const MCP_CREDENTIAL_KEY_ID = "mcp_cred_v1";

export interface ResolvedKms {
  adapter: KmsAdapter;
  keyId: string;
}

export function resolveCredentialKms(): ResolvedKms | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: MCP_CREDENTIAL_KEY_ID,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- kms`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/src/credentials/kms.ts packages/plugins/src/credentials/kms.test.ts
git commit -m "feat(plugins): credential KMS adapter resolver"
```

---

## Task 10: Credential encrypt/decrypt service

**Files:**
- Create: `packages/plugins/src/credentials/credential-service.ts`
- Create: `packages/plugins/src/credentials/credential-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/src/credentials/credential-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import {
  encryptCredentialSecrets,
  decryptCredentialSecrets,
  MCP_CREDENTIAL_KEY_ID,
} from "./credential-service";

const kms = {
  adapter: createLocalKmsAdapter(loadMasterKey(Buffer.alloc(32, 9).toString("base64"))),
  keyId: MCP_CREDENTIAL_KEY_ID,
};

describe("credential-service", () => {
  it("round-trips access + refresh + secret tokens", async () => {
    const enc = await encryptCredentialSecrets(
      { accessToken: "at-123", refreshToken: "rt-456", secret: null, oauthClientSecret: null },
      kms,
    );
    expect(enc.tokenKmsKeyId).toBe(MCP_CREDENTIAL_KEY_ID);
    expect(Buffer.isBuffer(enc.accessTokenEnc)).toBe(true);
    expect(enc.secretEnc).toBeNull();

    const dec = await decryptCredentialSecrets(
      {
        tokenKmsKeyId: enc.tokenKmsKeyId,
        accessTokenEnc: enc.accessTokenEnc,
        refreshTokenEnc: enc.refreshTokenEnc,
        secretEnc: enc.secretEnc,
        oauthClientSecretEnc: enc.oauthClientSecretEnc,
      },
      kms,
    );
    expect(dec.accessToken).toBe("at-123");
    expect(dec.refreshToken).toBe("rt-456");
    expect(dec.secret).toBeNull();
  });

  it("encrypts a header secret for the secret auth kind", async () => {
    const enc = await encryptCredentialSecrets(
      { accessToken: null, refreshToken: null, secret: "sk-live-789", oauthClientSecret: null },
      kms,
    );
    expect(Buffer.isBuffer(enc.secretEnc)).toBe(true);
    const dec = await decryptCredentialSecrets(
      { tokenKmsKeyId: enc.tokenKmsKeyId, secretEnc: enc.secretEnc },
      kms,
    );
    expect(dec.secret).toBe("sk-live-789");
  });

  it("returns null plaintext when no kms key id is present", async () => {
    const dec = await decryptCredentialSecrets(
      { tokenKmsKeyId: null, accessTokenEnc: Buffer.from("x") },
      kms,
    );
    expect(dec.accessToken).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- credential-service`
Expected: FAIL with "Cannot find module './credential-service'".

- [ ] **Step 3: Write `packages/plugins/src/credentials/credential-service.ts`**

```ts
/**
 * Envelope-encrypts plugin credential secrets (OAuth access/refresh tokens,
 * API-key/header secrets, OAuth client secret) for storage in mcp.credentials.
 *
 * Modeled on packages/auth/src/token-encryption.ts: the service layer encrypts
 * before write and decrypts after read; the *_enc columns store opaque Buffers.
 * NEVER log plaintext secret values in this module.
 */
import { encrypt, decrypt } from "@oxagen/crypto";
import type { ResolvedKms } from "./kms";

export { MCP_CREDENTIAL_KEY_ID } from "./kms";

/** Plaintext secrets supplied by the caller for encryption. */
export interface CredentialPlaintext {
  accessToken?: string | null;
  refreshToken?: string | null;
  secret?: string | null;
  oauthClientSecret?: string | null;
}

/** Encrypted column values written to mcp.credentials. */
export interface CredentialCiphertext {
  accessTokenEnc: Buffer | null;
  refreshTokenEnc: Buffer | null;
  secretEnc: Buffer | null;
  oauthClientSecretEnc: Buffer | null;
  tokenKmsKeyId: string;
}

async function enc1(
  value: string | null | undefined,
  kms: ResolvedKms,
): Promise<Buffer | null> {
  if (value == null || value === "") return null;
  return encrypt(value, kms.keyId, { adapter: kms.adapter });
}

async function dec1(
  value: Buffer | null | undefined,
  keyId: string,
  kms: ResolvedKms,
): Promise<string | null> {
  if (value == null) return null;
  const buf = await decrypt(value, keyId, { adapter: kms.adapter });
  return buf.toString("utf8");
}

/** Encrypt all secret fields. Returns only the encrypted columns + key id. */
export async function encryptCredentialSecrets(
  data: CredentialPlaintext,
  kms: ResolvedKms,
): Promise<CredentialCiphertext> {
  const [accessTokenEnc, refreshTokenEnc, secretEnc, oauthClientSecretEnc] =
    await Promise.all([
      enc1(data.accessToken, kms),
      enc1(data.refreshToken, kms),
      enc1(data.secret, kms),
      enc1(data.oauthClientSecret, kms),
    ]);
  return {
    accessTokenEnc,
    refreshTokenEnc,
    secretEnc,
    oauthClientSecretEnc,
    tokenKmsKeyId: kms.keyId,
  };
}

/** Encrypted column values read from mcp.credentials, for decryption. */
export interface CredentialCiphertextRead {
  tokenKmsKeyId: string | null;
  accessTokenEnc?: Buffer | null;
  refreshTokenEnc?: Buffer | null;
  secretEnc?: Buffer | null;
  oauthClientSecretEnc?: Buffer | null;
}

/** Decrypt all secret fields. Rows without a key id predate encryption. */
export async function decryptCredentialSecrets(
  data: CredentialCiphertextRead,
  kms: ResolvedKms,
): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
  secret: string | null;
  oauthClientSecret: string | null;
}> {
  const keyId = data.tokenKmsKeyId;
  if (!keyId) {
    return { accessToken: null, refreshToken: null, secret: null, oauthClientSecret: null };
  }
  const [accessToken, refreshToken, secret, oauthClientSecret] = await Promise.all([
    dec1(data.accessTokenEnc, keyId, kms),
    dec1(data.refreshTokenEnc, keyId, kms),
    dec1(data.secretEnc, keyId, kms),
    dec1(data.oauthClientSecretEnc, keyId, kms),
  ]);
  return { accessToken, refreshToken, secret, oauthClientSecret };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- credential-service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/src/credentials/credential-service.ts packages/plugins/src/credentials/credential-service.test.ts
git commit -m "feat(plugins): credential encrypt/decrypt service"
```

---

## Task 11: Wire the barrel and typecheck the whole package

**Files:**
- Modify: `packages/plugins/src/index.ts` (already references the service from Task 1)

- [ ] **Step 1: Confirm the barrel re-exports resolve**

Verify `packages/plugins/src/index.ts` exports match the implemented names: `encryptCredentialSecrets`, `decryptCredentialSecrets`, `MCP_CREDENTIAL_KEY_ID`, and the `CredentialPlaintext` / `CredentialCiphertext` types. They do (Task 1 Step 4). If `resolveCredentialKms` / `ResolvedKms` should be public, add:

```ts
export { resolveCredentialKms } from "./credentials/kms";
export type { ResolvedKms } from "./credentials/kms";
```

- [ ] **Step 2: Typecheck the new package**

Run: `pnpm --filter @oxagen/plugins typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full package test suite**

Run: `pnpm --filter @oxagen/plugins test:unit`
Expected: PASS (kms 3 + credential-service 3 = 6 tests).

- [ ] **Step 4: Typecheck the database package once more (full)**

Run: `pnpm --filter @oxagen/database typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/src/index.ts
git commit -m "chore(plugins): finalize credential service barrel exports"
```

---

## Done criteria for Plan 1

- `mcp`, `plugin`, `notification` schemas exist with all six tables; `agent.mcp_servers` has `org_listing_id`.
- Migration `0008_installable_plugins.sql` applies cleanly via `pnpm db:migrate`; the official MCP registry is seeded as a global default (`is_default_seed = true`, `org_id NULL`).
- `@oxagen/plugins` builds, typechecks, and its credential service round-trips OAuth/secret values through AES-256-GCM envelope encryption (6 passing unit tests).
- No plaintext token/secret columns anywhere; encrypted columns are `bytea` via `encryptedBytea`.

**Next plan:** `2026-06-06-installable-plugins-02-catalog-sync.md` — registry OpenAPI client, Inngest sync job, README fetch/sanitize, and the `plugin.catalog.browse`/`catalog.get` capabilities reading these tables.
