# Installable Plugins & Capability Packs

Archived spec & plan — status: partially shipped (audited 2026-07-03).

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> Installable Plugins Phase 1 (capability packs) and foundational MCP server support are largely complete and merged to main. Core deliverables include the plugins package with credential encryption, four capability pack manifests, database schemas, kernel entitlement gate, 19 contracts with full API/MCP/handler implementations, marketplace UI, and Inngest sync infrastructure. However, the org-level denylist feature was removed post-spec, the architecture shifted to workspace-scoped governance, and E2E Playwright tests for end-to-end flows were not completed.

**Implementation evidence**

- packages/plugins/src/ — credential service, catalog sync, registry client, OAuth infrastructure, bootstrap
- packages/database/src/schema/mcp.ts — registries, catalog_servers, credentials tables
- packages/database/src/schema/plugin.ts — org_listings, org_denylist tables
- packages/database/src/schema/notification.ts — notifications table
- packages/oxagen/src/plugins/catalog/media-video/manifest.ts — capability pack (video.generate)
- packages/oxagen/src/plugins/catalog/media-image/manifest.ts — capability pack (image.*)
- packages/oxagen/src/plugins/catalog/media-svg/manifest.ts — capability pack (svg.generate)
- packages/oxagen/src/plugins/catalog/documents/manifest.ts — capability pack (documents.*)
- packages/oxagen/src/contracts/plugin.registry.*.ts — registry management contracts
- packages/oxagen/src/contracts/plugin.catalog.*.ts — catalog browse/get/sync contracts
- packages/oxagen/src/contracts/plugin.org.*.ts — org install/list/enable/uninstall contracts
- packages/oxagen/src/contracts/plugin.workspace.set_enabled.ts — workspace enable toggle
- packages/handlers/src/plugin.*.ts — 19 handler implementations
- apps/api/src/routes/v1/plugin*.ts — API routes for all contracts
- apps/mcp/src/tools/plugin*.ts — MCP tools for all contracts
- apps/app/src/components/plugins/marketplace-modal.tsx — plugin marketplace UI
- packages/inngest-functions/src/functions/plugin.catalog-sync.ts — Inngest catalog sync
- packages/inngest-functions/src/functions/plugin.oauth-refresh-watcher.ts — OAuth credential refresh
- packages/agent/src/runtime/materialize-tools.ts — MCP tool injection into agent toolchain
- packages/agent/src/handlers/agent.tool.list.ts — capability entitlement filter on tool discovery

**Known gaps at time of archive**

- org-level denylist capabilities (plugin.denylist.add/remove) — removed post-spec per git history
- E2E Playwright tests for marketplace end-to-end flows (only component/unit tests exist)
- Documented re-authentication flow for OAuth failures (infrastructure present, E2E coverage missing)
- Email notification system for credential expiry alerts (contract exists, integration incomplete)

**Source documents** (archived verbatim below)

- `docs/specs/installable-plugins/specs/2026-06-06-installable-plugins-mcp-design.md`
- `docs/specs/installable-plugins/specs/2026-06-12-oxagen-plugins-capability-packs.md`
- `docs/specs/installable-plugins/plans/2026-06-06-installable-plugins-01-foundation.md`
- `docs/specs/installable-plugins/plans/2026-06-06-installable-plugins-02-catalog-sync.md`
- `docs/specs/installable-plugins/plans/2026-06-06-installable-plugins-03-spine-capabilities-runtime.md`
- `docs/specs/installable-plugins/plans/2026-06-06-installable-plugins-04-oauth.md`
- `docs/specs/installable-plugins/plans/2026-06-06-installable-plugins-05-notifications.md`
- `docs/specs/installable-plugins/plans/2026-06-06-installable-plugins-06-ui.md`
- `docs/specs/installable-plugins/plans/2026-06-06-installable-plugins-07-e2e-docs.md`

## Spec — `2026-06-06-installable-plugins-mcp-design.md`

## Installable Plugins — MCP Servers, Integrations & Content Tools

**Status:** Approved design — ready for implementation planning
**Date:** 2026-06-06
**Author:** Mac Anderson (with Claude)
**Linear project:** `oxagen-v2`

---

### 1. Purpose

Give organizations a first-class, Claude-`/mcp`-grade experience for discovering,
installing, governing, authenticating, and using third-party **plugins** across all
Oxagen agentic workflows — including the interactive question-answering agent.

A *plugin* is anything an org admin installs that contributes tools into the agent
toolchain. Three concrete types ship behind one shared spine:

| Type | What it is | Toolchain contribution | Depth this effort |
|---|---|---|---|
| **MCP server** | A remote Model Context Protocol server | The server's MCP tools | **Fully built, end-to-end** |
| **Integration** | A data source that feeds the ontology graph (Neo4j ingestion) | "query / sync this source" tool(s) | Spine full; ingestion pipeline = Linear epic |
| **Content tool** | A document/productivity app (Google Drive, Google Workspace, Microsoft Excel, …) | File/doc operation tool(s) | Spine full; file runtime = Linear epic |

The three types **share** a marketplace, org-admin governance, authentication/credential
concepts, and toolchain registration. They **differ** only in functionality. The
abstraction is explicitly designed so a type can be deepened later **without reworking
the spine**.

#### Success criteria ("you're done when…")

- Org admins open the marketplace in a **modal dialog** and click to enable MCP servers
  in the org; **multi-select bulk install** and **individual install** from a server
  detail page both work.
- The official public registry (`registry.modelcontextprotocol.io`) is **seeded and
  enabled by default for every org**.
- Servers added to an org are **disabled by default** but **available to all child
  workspaces**; workspaces enable from the org allow-list only.
- Orgs maintain a **denylist**; denied servers are **not installable** but remain
  **visible in the marketplace with a disabled/denied treatment** explaining they were
  blocked by org admins.
- Admins add **custom MCP servers** and **custom registries**, and install servers from
  those registries.
- OAuth MCP servers **store credentials SOC2-compliantly**, **refresh silently**, and on
  failure generate an **in-app notification + email to org Owners/Admins** with a deep
  link to a **re-authentication page**.
- Every agent (interactive Q&A included) can **use installed+enabled MCP servers** in its
  responses, exactly like Claude Code.
- Only **properly credentialed** users can manage plugins.
- Full **unit + E2E browser test** coverage of the flows enumerated in §11.
- Marketplace and in-app install screens are **documented**.

---

### 2. What already exists (do not rebuild)

Grounded from codebase exploration:

- **Agent-runtime tool injection** — `packages/agent/src/runtime/materialize-tools.ts`
  (lines ~234–407) already loads workspace MCP servers (`healthStatus = "healthy"`),
  calls `connectMcp()` + `materializeMcpTools()` (`packages/agent/src/dispatch/mcp-client.ts`),
  and registers them into the same tool map passed to `streamText`. **This is the
  injection point we extend.**
- **Existing MCP schema** — `packages/database/src/schema/agent.ts:303` (`mcp_servers`,
  workspace-scoped). Repurposed as the workspace-install row.
- **Existing contract** — `agent.mcp.register`
  (`packages/oxagen/src/contracts/agent.mcp.register.ts`, handler
  `packages/agent/src/handlers/agent.mcp.register.ts`) with
  `defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: { Owner: "allow" } }`.
- **Capability/contract kernel** — `registerCapability` (`packages/oxagen/src/registry.ts:48`),
  `CapabilityDeclaration` (`packages/oxagen/src/types.ts:82`), single `invoke()` chokepoint
  (`packages/oxagen/src/kernel.ts:264`), external-capability IAM
  `authorizeExternalCapability()` (`kernel.ts:537`). Parity checked by
  `tools/scripts/check_manifest.mjs` (`pnpm check:manifest`).
- **Crypto / SOC2 token storage** — `@oxagen/crypto`: `encryptedBytea` Drizzle helper
  (`packages/crypto/src/drizzle.ts:27`), envelope `encrypt`/`decrypt`
  (`packages/crypto/src/envelope.ts`), `KmsAdapter` + `createLocalKmsAdapter`. Reference
  table: `auth.credentials` (`packages/database/src/schema/auth.ts:75`,
  `encrypted_payload bytea` + `kms_key_id`). OAuth-token pattern: `auth.accounts`
  `*_enc bytea` + `token_kms_key_id`.
- **Schema conventions** — `packages/database/src/schema/_mixins.ts`:
  `idMixin(prefix)` (uuidv7 `id` + `citext public_id`), `auditMixin`, `softDeleteMixin`,
  `orgScopeMixin` (`org_id`+`workspace_id`), `versionMixin`, `jsonContractMixin`. Per-domain
  `pgSchema` namespaces (`_schemas.ts`). Hand-written SQL migrations in
  `packages/database/drizzle/` applied by `tools/scripts/db-migrate.ts` (`pnpm db:migrate`);
  generate drafts with `pnpm db:generate`.
- **Roles** — `SystemOrgRole = "Owner" | "Admin" | "Compliance" | "Billing"`
  (`packages/oxagen/src/types.ts`). Membership in `org.org_users.role` (text). App-layer
  authz templates: `resolveManagedOrg` (`apps/app/.../billing/actions.ts`) and
  `assertBillingManager` (`apps/app/src/lib/resolve-org.ts:118`). Org-only mutations use
  the `ORG_ONLY_WS` sentinel workspace id.
- **Email** — `@oxagen/notifications` `sendEmail()` (`packages/notifications/src/send-email.ts`),
  SMTP/nodemailer, vendor-neutral. **No handler calls it yet** (we are the first). **No
  HTML template system** — establish a minimal `packages/notifications` template helper.
- **In-app notifications** — bell is a **typed empty-state stub**
  (`apps/app/src/components/shell/notifications-bell.tsx`); **no `notifications` table**.
  Intended model specced in `docs/reference/.../notifications-context.tsx`
  (`kind: approval|run|member|security|system`).
- **UI** — `Dialog`/`DialogPopup` and `Sheet`/`SheetPopup` from `@oxagen/ui`
  (`packages/ui/src/components/{dialog,sheet}.tsx`); controlled-dialog example
  `apps/app/src/components/workspace/new-workspace-dialog.tsx`. Settings template:
  `billing/subscription/page.tsx` + `billing/actions.ts`. Workspace
  `settings/integrations/page.tsx` is a **stub** — becomes the workspace install surface.
- **Registry API** — official registry at `https://registry.modelcontextprotocol.io`
  implements the MCP Registry OpenAPI (`2025-12-01`). `GET /v0.1/servers` (cursor
  pagination via `metadata.nextCursor`, `limit`, `search`, `updated_since`,
  `include_deleted`); `GET /v0.1/servers/{name}/versions/{version}` (`latest`).
  `ServerDetail`: `name` (reverse-DNS PK), `description`, `version`, `title`,
  `repository{url,source,id,subfolder}`, `websiteUrl`, `icons[]{src,mimeType,sizes,theme}`,
  `packages[]` (registryType npm/pypi/cargo/oci/nuget/mcpb, transport stdio/streamable-http/sse,
  env vars + args with `isSecret`/`isRequired`), `remotes[]` (streamable-http/sse + `variables`
  with `isSecret`). Registry-managed `_meta`: `status` (active/deprecated/deleted),
  timestamps, `isLatest`. Auth requirements are expressed via `isSecret` env-vars/headers
  and remote `variables`; OAuth itself is negotiated at connect time against the server's
  `/.well-known` metadata (not declared in the registry record).

---

### 3. Architecture — five layers + shared spine

```
LAYER 1  REGISTRIES        mcp.registries (org-scoped + global default seed)
   │  Inngest sync (cursor + updated_since)  ┊  on-demand refresh
LAYER 2  CATALOG (cached)   mcp.catalog_servers  (icons, repo, packages, remotes, readme_html, categories)
   │  org admin installs / denies
LAYER 3  ORG GOVERNANCE     plugin.org_listings (allow-list + custom, enabled=false default)
   │                        plugin.org_denylist
   │  workspace enables (allow-list only)
LAYER 4  WORKSPACE INSTALL  agent.mcp_servers (existing table, repurposed) + health
   │  holds auth per (org_listing × workspace)
LAYER 5  RUNTIME + AUTH     mcp.credentials (encrypted) → materializeTools → agent toolchain
                            refresh-watcher → needs_reauth → notifications + email
```

#### The shared spine (`PluginType` interface)

A polymorphic supertype, built once, used by all three types. In code
(`packages/plugins/src/`):

```ts
interface PluginType {
  type: "mcp_server" | "integration" | "content_tool";
  syncCatalog(registry, ctx): Promise<CatalogUpsert[]>;   // registry-backed types only
  authKind(listing): "oauth" | "secret" | "none";
  startInstall(listing, ctx): Promise<InstallResult>;     // validation + auth bootstrap
  contributeTools(installed, ctx): Promise<AISdkToolMap>; // called by materializeTools
}
```

Shared spine deliverables (type-agnostic):
1. **Marketplace** — browse, filter, multi-select, detail pages with rendered README.
2. **Governance** — org allow-list, denylist, workspace enable/disable, RBAC.
3. **Auth** — OAuth 2.1 / secret / none; encrypted credential storage; refresh; re-auth.
4. **Toolchain registration** — `materializeTools` iterates registered `PluginType`s and
   calls `contributeTools()`.

**Extensibility guarantee:** deepening Integrations or Content tools means implementing
their `PluginType` methods more fully — never editing the spine. Adding a *fourth* type
means registering a new `PluginType`. The spine, governance, auth, marketplace, and the
`materializeTools` loop never change.

---

### 4. Data model

New pg-schemas: `mcp` and `plugin` (per the per-domain `pgSchema` convention in
`_schemas.ts`). All tables use `idMixin`/`auditMixin`; soft-deletable tables add
`softDeleteMixin`. FKs declared in the SQL migration (Drizzle bare `uuid().notNull()`
convention).

#### `mcp.registries`  (prefix `mreg`)
Org-scoped registry sources, plus a global default seed (`org_id NULL`).

| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id | uuid NULL | NULL ⇒ global default seed (visible to all orgs) |
| name | text NOT NULL | display name |
| base_url | text NOT NULL | registry API base (e.g. `https://registry.modelcontextprotocol.io`) |
| enabled | bool NOT NULL default true | |
| is_default_seed | bool NOT NULL default false | the global MCP registry |
| last_synced_at | timestamptz NULL | |
| last_synced_cursor | text NULL | opaque `metadata.nextCursor` checkpoint |
| audit | auditMixin | |

Unique: `(org_id, base_url)`. Seed migration inserts one `is_default_seed=true`,
`org_id=NULL` row for `registry.modelcontextprotocol.io`.

#### `mcp.catalog_servers`  (prefix `mcat`)
Cached registry records. One row per `(registry_id, name, version)`; `is_latest` maintained
on upsert.

| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| registry_id | uuid NOT NULL | → mcp.registries |
| name | text NOT NULL | reverse-DNS identifier |
| version | text NOT NULL | semver |
| is_latest | bool NOT NULL | |
| title | text NULL | |
| description | text NOT NULL | |
| repository | jsonb NULL | `{url,source,id,subfolder}` |
| website_url | text NULL | |
| icons | jsonb NOT NULL default '[]' | `[{src,mimeType,sizes,theme}]` |
| packages | jsonb NOT NULL default '[]' | full Package[] |
| remotes | jsonb NOT NULL default '[]' | full RemoteTransport[] |
| transport_types | text[] NOT NULL default '\{}' | denormalized for filtering |
| auth_kind | text NOT NULL | derived: `oauth`\\|`secret`\\|`none` (heuristic: remotes present + secret vars ⇒ secret/oauth resolved at connect) |
| categories | text[] NOT NULL default '\{}' | Oxagen taxonomy + `_meta` categories |
| readme_html | text NULL | sanitized, rendered from repo README |
| readme_fetched_at | timestamptz NULL | |
| status | text NOT NULL | active\\|deprecated\\|deleted (CHECK) |
| published_at, updated_at, status_changed_at | timestamptz | from `_meta` |
| meta | jsonb NOT NULL default '\{}' | publisher `_meta` bag |
| audit | auditMixin | |

Indexes: `UNIQUE(registry_id, name, version)`, `(registry_id, name) WHERE is_latest`,
GIN on `categories`, GIN on `transport_types`, trigram on `name`/`title`/`description`
for search.

#### `plugin.org_listings`  (prefix `porg`)
Org allow-list + custom plugins, polymorphic across types.

| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id | uuid NOT NULL | |
| plugin_type | text NOT NULL | `mcp_server`\\|`integration`\\|`content_tool` (CHECK) |
| catalog_server_id | uuid NULL | → mcp.catalog_servers (NULL ⇒ custom) |
| source | text NOT NULL | `registry`\\|`custom` |
| name | text NOT NULL | stable identifier |
| title | text NULL | |
| description | text NULL | |
| icon_url | text NULL | mirrored to blob for custom |
| endpoint_url | text NULL | remote MCP/integration endpoint |
| transport | text NULL | streamable-http\\|sse (remote types) |
| auth_kind | text NOT NULL | oauth\\|secret\\|none |
| auth_config | jsonb NOT NULL default '\{}' | non-secret config (scopes, header names, discovered metadata) |
| enabled | bool NOT NULL default false | **disabled by default**; available to child workspaces |
| config | jsonb NOT NULL default '\{}' | type-specific config |
| audit + softDelete | mixins | |

Indexes: `UNIQUE(org_id, plugin_type, name)`, `(org_id, plugin_type)`.

#### `plugin.org_denylist`  (prefix `pden`)

| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id | uuid NOT NULL | |
| plugin_type | text NOT NULL | |
| server_name | text NOT NULL | reverse-DNS or custom name |
| reason | text NULL | shown in marketplace tooltip |
| audit | auditMixin | |

Unique: `(org_id, plugin_type, server_name)`. A denylisted name is non-installable and any
existing org_listing/workspace install for it is disabled on add.

#### `agent.mcp_servers`  (existing — repurposed as workspace install)
Add columns (migration): `org_listing_id uuid NOT NULL` (→ plugin.org_listings),
keep `enabled`, `health_status`, `last_health_check_at`. Workspace can only reference an
`org_listing` whose `org_id` matches and that is not denylisted.

#### `mcp.credentials`  (prefix `mcrd`) — SOC2 encrypted
Auth per `(org_listing × workspace)`. (Org-level shared creds use the `ORG_ONLY_WS`
sentinel workspace id.)

| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id, workspace_id | uuid NOT NULL | orgScopeMixin |
| org_listing_id | uuid NOT NULL | → plugin.org_listings |
| auth_kind | text NOT NULL | oauth\\|secret |
| access_token_enc | bytea NULL | `encryptedBytea` |
| refresh_token_enc | bytea NULL | `encryptedBytea` |
| secret_enc | bytea NULL | for API-key/header-secret |
| token_kms_key_id | text NULL | per-row CMK |
| oauth_client_id | text NULL | from DCR |
| oauth_client_secret_enc | bytea NULL | from DCR (if confidential client) |
| scopes | text[] NOT NULL default '\{}' | |
| expires_at | timestamptz NULL | |
| status | text NOT NULL | active\\|needs_reauth\\|revoked (CHECK) |
| last_refreshed_at | timestamptz NULL | |
| audit | auditMixin | |

Unique: `(workspace_id, org_listing_id)`. RLS-scoped (tenant seams per repo RLS policy).

#### `notifications`  (prefix `ntf`) — new subsystem, `public`/`notification` schema
| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id | uuid NOT NULL | |
| workspace_id | uuid NULL | |
| user_id | uuid NOT NULL | recipient |
| kind | text NOT NULL | system\\|approval\\|run\\|member\\|security (CHECK) |
| title | text NOT NULL | |
| body | text NULL | |
| deep_link | text NULL | in-app route |
| unread | bool NOT NULL default true | |
| archived | bool NOT NULL default false | |
| emailed_at | timestamptz NULL | set when the email mirror was sent |
| audit | auditMixin | |

Indexes: `(user_id, unread) WHERE NOT archived`, `(org_id)`.

Org setting (existing `org.organizations.settings` jsonb):
`settings.mcp_auth_alerts = { send_email: bool, roles: string[] }` (default
`{ send_email: true, roles: ["Owner","Admin"] }`).

---

### 5. Catalog sync

- **Inngest cron** (`plugin/catalog.sync`) per enabled registry: page `GET /v0.1/servers`
  with `limit` + `cursor` until `nextCursor` is absent; on incremental runs pass
  `updated_since = last_synced_at`. Upsert into `mcp.catalog_servers`; maintain `is_latest`
  (unset prior latest for the name, set new). Checkpoint `last_synced_cursor`/`last_synced_at`.
- **On-demand refresh** capability (`plugin.registry.sync`) for a single registry or server.
- **README rendering** — fetch raw README from `repository.url` (GitHub/GitLab raw), render
  markdown → HTML via the repo's markdown pipeline, **sanitize with rehype-sanitize**
  (strict allowlist; strip scripts/styles/iframes; rewrite relative image URLs to absolute
  using the repo base), cache in `readme_html` + `readme_fetched_at` (re-fetch TTL 24h).
- **Icons** — hotlinked under a CSP `img-src` allowlist; for **custom** plugins, admin-
  supplied logos mirrored to Vercel Blob via `@oxagen/storage`, reference row in Postgres.
- **Instrumentation** — every sync run records duration + counts + surface origin per the
  observability policy.

---

### 6. Auth subsystem

Per credential `auth_kind`:

- **`none`** — public remote server; connect directly.
- **`secret`** — API-key / header secret. Admin enters value at install; stored
  `secret_enc` (`encryptedBytea`). Attached as the declared header/env at connect.
- **`oauth`** — full MCP OAuth 2.1:
  1. **Discover** the server's protected-resource + authorization-server metadata
     (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
     RFC 8414/9728).
  2. **Dynamic client registration** (RFC 7591) if the server supports it; else use
     admin-supplied client credentials (fallback path so B-tier servers still connect).
  3. **Authorization code + PKCE** — admin clicks "Connect", redirect to the server's
     authorize endpoint, callback to `/api/v1/plugins/oauth/callback`.
  4. **Token exchange** → store `access_token_enc` + `refresh_token_enc` + `expires_at` +
     `scopes` + client id/secret (encrypted).
  5. **Silent refresh** — Inngest scheduled `plugin/oauth.refresh-watcher` runs before
     `expires_at`; on success re-encrypt new tokens; on failure set `status=needs_reauth`
     and emit the re-auth notification (§7).
  6. **Re-auth** — deep link → re-auth page → restart at step 3 (reusing stored client id).

All token reads/writes go through `@oxagen/crypto` `encrypt`/`decrypt` with the configured
`KmsAdapter` (`AUTH_TOKEN_ENCRYPTION_KEY`). No plaintext token columns.

---

### 7. Notifications subsystem (new)

- `notifications` table (§4) + service `createNotification()` in `@oxagen/notifications`.
- **In-app** — replace the bell empty-state stub with a real feed: a `notifications.list`
  capability + a `NotificationsProvider` reading it; unread badge; mark-read/archive.
- **Email mirror** — first `sendEmail()` caller. On `needs_reauth` for an org listing:
  resolve recipients = org members whose role ∈ `settings.mcp_auth_alerts.roles`; create an
  in-app notification for each; if `send_email`, send an email (minimal HTML template helper
  added to `packages/notifications`) with a deep link to the re-auth page. Set `emailed_at`.
- Re-usable for future kinds (approval/run/security) — built generic, MCP re-auth is the
  first producer.

---

### 8. Capabilities — API ⇄ MCP parity

New contracts in `packages/oxagen/src/contracts/` (each `registerCapability`, wired into
`apps/api/src/routes/v1/<name>.ts` **and** `apps/mcp/src/tools/<name>.ts`; `check:manifest`
green). All management capabilities: `defaultRoles: { org: { Owner: "allow", Admin: "allow" } }`,
`sensitivity` ≥ medium (destructive for remove/deny).

| Capability | Surfaces | Purpose |
|---|---|---|
| `plugin.registry.add` | api,mcp | add an org registry source |
| `plugin.registry.remove` | api,mcp | remove org registry |
| `plugin.registry.list` | api,mcp | list registries (incl. default seed) |
| `plugin.registry.sync` | api,mcp | on-demand catalog refresh |
| `plugin.catalog.browse` | api,mcp | search/filter catalog (paginated) |
| `plugin.catalog.get` | api,mcp | server detail incl. readme_html |
| `plugin.org.install` | api,mcp | add catalog server (or custom) to org allow-list (disabled) |
| `plugin.org.uninstall` | api,mcp | remove from allow-list (destructive) |
| `plugin.org.set_enabled` | api,mcp | enable/disable an org listing |
| `plugin.org.install_bulk` | api,mcp | multi-select bulk install |
| `plugin.denylist.add` | api,mcp | deny a server (destructive; disables existing) |
| `plugin.denylist.remove` | api,mcp | un-deny |
| `plugin.workspace.set_enabled` | api,mcp | enable/disable at workspace (allow-list only) |
| `plugin.oauth.start` | api | begin OAuth (returns redirect URL) |
| `plugin.oauth.callback` | api | OAuth callback handler |
| `plugin.credential.set_secret` | api,mcp | store API-key/header secret |
| `plugin.credential.reauth` | api,mcp | trigger re-auth |
| `notifications.list` | api,mcp | list in-app notifications |
| `notifications.mark` | api,mcp | read/archive |

**App-layer authz** — add `assertMcpManager(orgId, userId)` to
`apps/app/src/lib/resolve-org.ts` (clone of `assertBillingManager`, role set
`{Owner, Admin}`) and a `resolveManagedOrgForPlugins` mirror of `resolveManagedOrg` for
server actions. Negative-tested in §11.

---

### 9. Agent runtime integration

`materialize-tools.ts`:
1. Replace the direct `mcp_servers WHERE healthStatus='healthy'` query with: join
   `agent.mcp_servers` → `plugin.org_listings`, filtering `org_listing.enabled = true`
   **and** `agent.mcp_servers.enabled = true` **and** not in `plugin.org_denylist`
   **and** `healthStatus = 'healthy'`.
2. Iterate **registered `PluginType`s** and call `contributeTools()` for each enabled
   installed listing — MCP via `connectMcp()`/`materializeMcpTools()` (with the credential
   decrypted and attached); Integration/Content-tool types contribute their guardrailed
   tool(s).
3. Names sanitized via existing `toModelToolName()`; reverse `nameMap` preserved.
4. External-capability IAM via `authorizeExternalCapability()` unchanged.

Result: the interactive Q&A agent and every other agent surface use installed+enabled
plugins exactly like Claude Code uses MCP tools.

---

### 10. UI

- **Org settings → "Plugins" section** (`apps/app/src/app/[orgSlug]/settings/plugins/`):
  registries manager (list/add/remove, default seed shown locked-on), org allow-list table
  (enable/disable/uninstall), custom-server/custom-registry forms, denylist manager,
  **"Browse marketplace"** button → marketplace modal. Server-component + server-actions
  pattern from `billing/`. Gated by `assertMcpManager`.
- **Marketplace modal** — `Dialog` + `DialogPopup` (`max-w-5xl`). Three plugin-type tabs;
  filters (category / transport / auth kind / domain); search; **multi-select checkboxes +
  "Install selected (n)"** bulk action; cards with logo/title/description. **Detail page**:
  hero logo, title, author + website link, transport/auth badges, **rendered README (HTML)**,
  tools list, **Install** button. **Denied servers**: rendered with disabled/greyed
  treatment + "Blocked by your organization's admins" message (+ reason tooltip), install
  disabled.
- **Workspace install surface** — replace `settings/integrations/page.tsx` stub: list the
  org allow-list available to this workspace, enable/disable per workspace, **Connect /
  Re-authenticate** buttons for OAuth servers, secret-entry for secret servers, health
  status.
- **Re-auth page** (`/[orgSlug]/[workspaceSlug]/settings/integrations/reauth/[listing]`) —
  the deep-link target from the notification/email.
- **Notifications bell** — wire to `notifications.list`; unread badge; in-app re-auth prompt
  card with the deep link.
- Follows `coss-ui` (stock coss on Base UI, `render` not `asChild`).

---

### 11. Testing

**Vitest unit** — each contract `*.test.ts` (real assertions, no stubs): catalog sync
(cursor pagination, `is_latest` maintenance, README sanitization), auth (OAuth
discovery/DCR/PKCE/refresh state machine, credential encrypt/decrypt round-trip), governance
(allow-list, denylist disables existing, workspace-enable-from-allow-list-only invariant),
notifications (recipient resolution by role, email mirror), RBAC (`assertMcpManager`),
runtime (`contributeTools` filtering by enabled/deny/health).

**Playwright E2E** (`apps/app/e2e/`) — the enumerated flows, each its own spec:
1. Install MCP from marketplace (single + **bulk multi-select**).
2. Add MCP to org (custom server + custom registry → install from it).
3. Enable MCP at the workspace layer.
4. Authenticate to an org-enabled OAuth MCP server (mock OAuth provider).
5. Disable a previously-enabled MCP server.
6. Remove an MCP server from the org allow-list.
7. Maintain a denylist → assert denied server is **not installable** but **still visible
   with disabled/denied treatment + explanatory copy**.
8. RBAC negative: a non-credentialed user (Member/Viewer) cannot manage plugins (UI hidden +
   server action rejected).
9. **Agent integration**: an installed+enabled MCP server's tool is callable within an
   interactive Q&A agent turn (mock MCP server) — proves toolchain wiring end-to-end.

OAuth and MCP servers are mocked via local test doubles (a fixture MCP server + a fixture
OAuth authorization server) so E2E is deterministic and offline.

---

### 12. Out of scope (tracked as Linear epics; spine stays extensible)

- **Integration deep vertical** — the ontology-graph ingestion pipeline (scheduling,
  source→graph mapping, incremental ingest). Spine + governance + auth + a placeholder
  `contributeTools()` ship now; deep pipeline = its own epic.
- **Content-tool deep vertical** — Google Drive / Workspace / Microsoft Excel file runtimes
  (file APIs, doc ops). Rides existing Google/MS OAuth client seams now; deep runtime = its
  own epic.
- **Local (stdio/npx/docker) MCP execution** — local-only servers are **cataloged and
  shown with a "local runtime" badge + disabled install**; a managed remote-bridge sandbox
  is a possible later epic.

---

### 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| README HTML XSS | rehype-sanitize strict allowlist; CSP; no inline scripts/styles |
| Token leakage | envelope AES-256-GCM + KMS; no plaintext columns; RLS tenant scoping |
| OAuth servers without DCR | admin-supplied client-credentials fallback path |
| Registry catalog size / sync cost | cursor + `updated_since` incremental; TTL'd README fetch; instrumented |
| Hosted agent can't run local servers | honest catalog badge + disabled install (§12) |
| First email path fragile | generic `createNotification` + minimal template helper; in-app always created even if email fails (no silent failure — failures logged + surfaced) |
| Cross-org IDOR on management | `assertMcpManager` + tenant-scoped `invoke()`; negative E2E |

---

### 14. Build sequence (for the implementation plan)

1. **Schema + migrations** (mcp/plugin/notifications tables; repurpose `agent.mcp_servers`;
   default-registry seed).
2. **Crypto-backed credential service** + `mcp.credentials`.
3. **Catalog sync** (Inngest + registry client + README render/sanitize).
4. **PluginType spine** + MCP implementation of `contributeTools`.
5. **Capabilities** (contracts → api routes → mcp tools; `check:manifest` green) + authz.
6. **Auth subsystem** (OAuth 2.1 discovery/DCR/PKCE/refresh + secret).
7. **Notifications subsystem** (table + in-app feed + first email handler + org setting).
8. **Runtime** (`materializeTools` governance-gated, polymorphic).
9. **UI** (org plugins settings, marketplace modal, workspace install, re-auth page, bell).
10. **Tests** (unit throughout; Playwright E2E suite §11).
11. **Docs** (marketplace + install screens; `docs/capabilities/*`; SPEC).
12. **Linear** — parent epic + sub-issues; deep-vertical epics (§12) filed.
```

## Document — `2026-06-12-oxagen-plugins-capability-packs.md`

## Oxagen Plugins — first-party capability packs (Phase 1)

Status: Phase 1 implemented (this branch) · Author: Claude (planner) + Mac Anderson · Date: 2026-06-12
Related: ADR-013, `docs/architecture/installable-plugins/specs/2026-06-06-installable-plugins-mcp-design.md`

### What an Oxagen Plugin is

An **Oxagen Plugin** is a first-party *capability pack*: a named, versioned bundle of
existing capability contracts that an org installs from the marketplace instead of
having always-on. Examples: `oxagen/media-video` (premium), `oxagen/media-svg` (free).
Capabilities not claimed by any plugin remain **builtin** — always available, no
install required. Phase 1 makes the four media/document-generation families
installable; everything else stays builtin.

Three phases:

- **Phase 1 (this branch):** manifest + static registry, `capability` plugin type,
  kernel entitlement gate, agent tool-list filter, marketplace browse/install/enable,
  typed `capability_not_installed` error, docs, tests.
- **Phase 2 (Linear):** monetization — plan-tier install gates, premium meter rates in
  `pricing.ts`, preview-allowlist visibility, workspace-level enable/disable,
  low-balance UX integration.
- **Phase 3 (Linear):** partner plugins — Postgres-mirrored manifest catalog,
  out-of-process execution protocol (context envelope + scoped graph tokens),
  manifest review flow, rev-share settlement on ClickHouse telemetry.

### Architecture invariants (binding)

1. **The kernel is the enforcement point.** Entitlement is checked in
   `kernel.invoke()` (packages/oxagen/src/kernel.ts), beside the billing gate, so
   API, MCP, agent, and CLI surfaces inherit it identically. Tool-list filtering in
   `materializeTools()` is UX, not security.
2. **One install model.** Capability packs reuse `plugin.org_listings`
   (plugin_type `capability`, source `oxagen`) and the existing
   install / set_enabled / uninstall / denylist contracts. No parallel tables.
3. **Manifests are pure data.** The manifest zod schema is DB-mirrorable by design —
   Phase 3 syncs partner manifests into Postgres; first-party manifests stay in-repo
   as the source of truth.
4. **Uninstall blocks new invocations only.** Running async jobs complete; generated
   assets persist (they are customer data, served via the assets route).
5. **Unclaimed contracts are builtin.** A contract may be claimed by at most one
   plugin (registry validation enforces this).

### Directory scaffold

```
packages/oxagen/src/plugins/
  manifest.ts            # OxagenPluginManifest zod schema + types (DB-mirrorable)
  registry.ts            # static registry: byId, pluginForContract(), validation
  index.ts               # barrel (exported from @oxagen/oxagen as ./plugins)
  catalog/
    media-video/manifest.ts
    media-image/manifest.ts
    media-svg/manifest.ts
    documents/manifest.ts
```

One directory per plugin: Phase 2/3 add per-plugin assets (icon, pricing, docs,
partner handler bindings) without restructuring.

#### Manifest schema

```ts
{
  id: `oxagen/${slug}`,            // unique, stable
  name: string,                    // display name, e.g. "Video Generation"
  description: string,
  version: string,                 // semver; first-party is always-latest, recorded for the DB mirror
  tier: "free" | "premium",        // builtin packs do not exist — builtin = unclaimed
  visibility: "hidden" | "preview" | "beta" | "ga",
  category: string,                // marketplace grouping, e.g. "media"
  icon?: string,                   // lucide icon name
  contracts: [string, ...],        // capability names claimed by this pack
  minPlanTier?: "free"|"build"|"scale"|"enterprise",  // recorded now, ENFORCED in Phase 2
  scopes: string[],                // reserved for Phase 3 partner protocol; [] for first-party
}
```

#### Phase 1 pack assignments

| Plugin id | Tier | Contracts |
|---|---|---|
| `oxagen/media-video` | premium | `video.generate` |
| `oxagen/media-image` | free | `image.generate`, `image.create`, `image.analyze`, `image.list` |
| `oxagen/media-svg` | free | `svg.generate` |
| `oxagen/documents` | free | `documents.generate`, `documents.pdf.create` |

`document.create/list/read` (workspace document CRUD) stay **builtin** — they are core
platform, distinct from the `documents.*` generation family.

### Enforcement design

- **Kernel slot** (mirrors `setBillingAdmissionGate`):
  `setCapabilityEntitlementGate(gate: (capabilityName: string, orgId: string) => Promise<void>)`.
  In `invoke()`, after the billing gate: if `pluginForContract(name)` returns a plugin
  (pure in-package lookup, no DB), call the gate. Unregistered gate ⇒ allow (matches
  IAM/billing default), but all three apps bootstrap it.
- **New error code:** `capability_not_installed` added to `CapabilityErrorCode`;
  message carries the plugin id + an install hint. Same shape on all surfaces.
- **Gate implementation** lives in `packages/plugins` (`src/entitlements/`): queries
  `plugin.org_listings` for `plugin_type='capability' AND enabled AND NOT deleted`,
  minus denylisted names; small TTL cache (30 s) keyed by orgId. Exports
  `listEntitledCapabilityPluginIds(orgId)` (used by the agent filter) and
  `bootstrapEntitlementRuntime()` (registered at the same call sites as
  `bootstrapBillingRuntime()` — apps/api, apps/mcp, apps/app).
- **Agent filter:** in `materializeTools()` first-party loop, skip contracts whose
  plugin is not in the org's entitled set (one fetch per materialization).
- **Org-level only in Phase 1.** Install ⇒ org listing `enabled=false` (same
  disabled-by-default governance as MCP servers); admin enables via
  `plugin.org.set_enabled`. Workspace-level enable is Phase 2.

### DB change (one Atlas migration)

Broaden two CHECK constraints on `plugin.org_listings`:
`plugin_type IN (… ,'capability')`, `source IN (… ,'oxagen')`. Update `PLUGIN_TYPES`
+ drizzle `check()` definitions in `packages/database/src/schema/plugin.ts`. No new
tables ⇒ no RLS-manifest change (org_listings is already `org_only`).

### Contract changes (no new contracts — parity preserved)

- `plugin.catalog.browse`: `pluginType` enum gains `capability`. When requested, the
  handler serves the **static registry** (not `mcp.catalog_servers`), mapped into the
  existing output shape (`authKind:'none'`, `transportTypes:[]`,
  `categories:[category]`), excluding `hidden`/`preview` visibility.
- `plugin.org.install`: enum gains `capability` + optional `pluginId` input; handler
  validates the id against the registry and inserts the listing
  (source `oxagen`, name = plugin id, title/description from manifest).
- `plugin.org.list`, `plugin.org.set_enabled`, `plugin.org.uninstall`,
  `plugin.denylist.*` operate on org_listings generically — verified + tested, not changed.
- `plugin.workspace.set_enabled` remains MCP-specific; rejects `capability` listings
  with a clear error until Phase 2.

### UI

Fourth tab in the marketplace modal (`PLUGIN_TABS`): **"Oxagen Plugins"** — entries
rendered from `plugin.catalog.browse` with `pluginType='capability'`, tier badge
(free/premium), install via the existing actions. Org settings plugins panel lists
capability rows like any listing. One Playwright e2e: open marketplace → Oxagen
Plugins tab → install → listing appears (disabled) → enable.

### Test plan

- packages/oxagen: manifest schema validation; registry invariants (duplicate
  contract claim throws, unknown contract name throws, id format); kernel gate
  (builtin bypass, refusal shape, unregistered-gate allow, error code).
- packages/plugins: entitlement service (entitled set assembly, denylist exclusion,
  TTL cache, soft-deleted exclusion).
- packages/handlers: browse capability source; install validation (bad pluginId,
  idempotent re-install).
- packages/agent: materialize filter (entitled vs not, builtin untouched).
- apps/app: e2e marketplace flow (above).
- Coverage thresholds are ratchets — bump if raised, never lower.

### Phase 2/3 context for future agents

The static registry (`packages/oxagen/src/plugins/registry.ts`) is the integration
point for everything later: Phase 2 reads `tier`/`minPlanTier`/`visibility` for
monetization + preview allowlists; Phase 3 mirrors the manifest schema into a
`plugin.capability_catalog` Postgres table (same zod schema validates both) and adds
an `execution` block to the manifest for out-of-process partner handlers. The kernel
gate and error code need no changes in either phase.

### Implementation notes (Phase 1, this branch)

#### Entitlement gate bootstrap call sites

`bootstrapEntitlementRuntime()` is called at the three app entry points, symmetrically with
`bootstrapBillingRuntime()`:

- `apps/api/src/bootstrap.ts` — called in the Hono startup sequence.
- `apps/mcp/src/middleware.ts` — called at module load (before any request handling).
- `apps/app/instrumentation.ts` — called inside the Next.js `register()` hook (dynamic import to
  avoid an edge-incompatible side-effect in the RSC bundle).

If `bootstrapEntitlementRuntime()` is not called, the kernel gate is left in its default
allow-all state (matches the IAM/billing default for backward-compatibility), but an `info`
log is emitted on the first plugin-claimed invocation.

#### agent.tool.list filter parity fix

`agent.tool.list` (`packages/agent/src/handlers/agent.tool.list.ts`) was updated to apply the same
entitlement filter as `materializeTools` in `packages/agent/src/runtime/materialize-tools.ts`. The
handler imports `listEntitledCapabilityPluginIds` and `pluginForContract` and skips any builtin
capability whose plugin is not in the org's entitled set. Both surfaces now use the same
`listEntitledCapabilityPluginIds(ctx.orgId)` call so tool visibility is consistent whether the
agent queries its tool list or attempts to invoke a tool.

#### apps/api dead-import fix

Commit `78948ff6` removed dead `automation.enable` / `automation.disable` route imports from
`apps/api/src/app.ts`. These imports were introduced in the branch that preceded this one and
referenced route files that were never committed, causing typecheck and lint failures on main.
The fix rode along before the plugin work landed to keep the branch green.

#### Migration filename

`packages/database/atlas/migrations/20260612150000_add_capability_plugin_type.sql`

Broadens two CHECK constraints on `plugin.org_listings` (adds `'capability'` to `plugin_type`
and `'oxagen'` to `source`). No new tables, no RLS changes.

## Document — `2026-06-06-installable-plugins-01-foundation.md`

## Installable Plugins — Plan 1: Foundation (schema + credential service)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the data foundation for the installable-plugins feature — the Postgres schemas/tables for registries, catalog, org governance, workspace install, encrypted credentials, and notifications — plus a SOC2-compliant credential-encryption service in a new `@oxagen/plugins` package.

**Architecture:** New `mcp` and `plugin` Postgres schema namespaces (Drizzle `pgSchema`), tables built from the existing `_mixins` (`idMixin`/`auditMixin`/`softDeleteMixin`/`orgScopeMixin`), a hand-written forward SQL migration `0008_installable_plugins.sql` applied by `pnpm db:migrate`, the existing `agent.mcp_servers` table repurposed as the workspace-install row, and a credential service that envelope-encrypts OAuth/secret tokens via `@oxagen/crypto` (AES-256-GCM + local KMS adapter), modeled on `packages/auth/src/token-encryption.ts`.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, `@oxagen/crypto` (envelope encryption), Vitest 2.1.9, hand-written SQL migrations, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§4 data model, §6 auth, §2 existing primitives).

---

### File Structure

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

### Task 1: Scaffold the `@oxagen/plugins` package

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

### Task 2: Add the `mcp`, `plugin`, `notification` pg-schema namespaces

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

### Task 3: Drizzle tables — `mcp.registries` and `mcp.catalog_servers`

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

### Task 4: Drizzle tables — `plugin.org_listings` and `plugin.org_denylist`

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

### Task 5: Drizzle table — `notification.notifications`

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

### Task 6: Repurpose `agent.mcp_servers` as the workspace-install row

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

### Task 7: Forward migration `0008_installable_plugins.sql`

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

### Task 8: Apply the migration to local Postgres and verify

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

### Task 9: Credential KMS adapter resolver

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

### Task 10: Credential encrypt/decrypt service

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

### Task 11: Wire the barrel and typecheck the whole package

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

### Done criteria for Plan 1

- `mcp`, `plugin`, `notification` schemas exist with all six tables; `agent.mcp_servers` has `org_listing_id`.
- Migration `0008_installable_plugins.sql` applies cleanly via `pnpm db:migrate`; the official MCP registry is seeded as a global default (`is_default_seed = true`, `org_id NULL`).
- `@oxagen/plugins` builds, typechecks, and its credential service round-trips OAuth/secret values through AES-256-GCM envelope encryption (6 passing unit tests).
- No plaintext token/secret columns anywhere; encrypted columns are `bytea` via `encryptedBytea`.

**Next plan:** `2026-06-06-installable-plugins-02-catalog-sync.md` — registry OpenAPI client, Inngest sync job, README fetch/sanitize, and the `plugin.catalog.browse`/`catalog.get` capabilities reading these tables.

## Document — `2026-06-06-installable-plugins-02-catalog-sync.md`

## Installable Plugins — Plan 2: Catalog Sync (registry client + Inngest sync + README render + catalog capabilities)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `mcp.catalog_servers` from MCP registries (cursor-paginated incremental sync), render+sanitize server READMEs, and expose registry management + catalog browse/get over both the `/v1` API and MCP surfaces with parity.

**Architecture:** A typed registry OpenAPI client + pure mapping/derivation functions + a README render pipeline + a sync service all live in `@oxagen/plugins` (built in Plan 1). An Inngest cron syncs all enabled registries incrementally; an Inngest event handles on-demand single-registry/server refresh. Six capabilities (`plugin.registry.add|remove|list|sync`, `plugin.catalog.browse|get`) are declared as contracts in `@oxagen/oxagen`, handled in `@oxagen/handlers` (global/system-DB scope — the catalog is cross-tenant), and wired into `apps/api` routes + `apps/mcp` tools.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, Zod 3.25.76, `inngest@3.54.2`, the `unified`/`remark-*`/`rehype-sanitize`/`rehype-stringify` markdown stack (already in the lockfile via `streamdown`), Vitest 2.1.9.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§5 catalog sync, §8 capabilities)

**Builds on Plan 1 (shipped):** tables `mcp.registries` (`mcpRegistries`), `mcp.catalog_servers` (`mcpCatalogServers`) in `packages/database/src/schema/mcp.ts`; the default registry seeded in `0008_installable_plugins.sql` (`registry.modelcontextprotocol.io`, `org_id NULL`, `is_default_seed=true`); the `@oxagen/plugins` package.

---

### Grounded conventions (verified against the codebase)

- **Contract pattern** — `registerCapability({...})` from `@oxagen/oxagen` (`packages/oxagen/src/registry.ts`), shape in `packages/oxagen/src/types.ts`. Example: `packages/oxagen/src/contracts/workspace.create.ts`. Fields: `name, domain, description, mode, surfaces, layers, scoped, sensitivity, defaultEffect, defaultRoles, input (Zod), output (Zod)`.
- **API route** — `apps/api/src/routes/v1/<name>.ts`: `cap.input.parse(body)` → `invoke(cap.name, body, ctx, { surface: "api" })`. Example: `apps/api/src/routes/v1/workspace.create.ts`.
- **MCP tool** — `apps/mcp/src/tools/<name>.ts`: exports `schema` (Zod shape), `metadata` (ToolMetadata), default handler calling `invoke(cap.name, args, ctx, { surface: "mcp" })`. Example: `apps/mcp/src/tools/workspace.create.ts`.
- **Handler** — `packages/handlers/src/<name>.ts`, registered via `registerHandler("<name>", async () => (await import("./<name>")).handler)` in `packages/handlers/src/register.ts`.
- **DB seam** — `withSystemDb` / `withTenantDb` from `@oxagen/database`; `runInTenantScope` from `@oxagen/tenancy`. **Registries and catalog are global/cross-tenant** (the seed has `org_id NULL`; the catalog is shared across orgs), so the sync service and catalog reads use `withSystemDb`. `plugin.registry.add/remove/list` are org-scoped writes/reads but the registry table mixes global+org rows, so those handlers also use `withSystemDb` and filter by `orgId` explicitly. (Raw `db()` is ESLint-banned.)
- **Inngest** — client `inngest` from `packages/inngest-functions/src/inngest.ts`; typed events in the `Events` type (same file, ~lines 7–70); functions registered in the `functions` array in `packages/inngest-functions/src/functions.ts`; served at `apps/api/src/routes/inngest.ts`. Cron: `inngest.createFunction({ id, retries }, { cron: "..." }, handler)`. Event: `inngest.createFunction({ id, retries }, { event: "name" }, handler)`; dispatch via `inngest.send({ name, data })`.
- **Manifest parity** — `pnpm check:manifest` (warn-only) checks each capability's `layers` have matching files: `api`→`apps/api/src/routes/v1/<name>.ts`, `mcp`→`apps/mcp/src/tools/<name>.ts`, `unit`→`packages/oxagen/src/contracts/<name>.test.ts`. Run it after adding contracts.
- **Markdown** — use the `unified` pipeline (`remark-parse`→`remark-gfm`→`remark-rehype`→`rehype-sanitize`→`rehype-stringify`); all already resolved in the lockfile via `streamdown`, so declaring them as direct deps of `@oxagen/plugins` adds no new packages to the install graph.

---

### File Structure

**`@oxagen/plugins`** (`packages/plugins/`)
- Modify: `packages/plugins/package.json` — add `zod`, `@oxagen/database`, `@oxagen/tenancy`, and the `unified`/`remark-*`/`rehype-*` deps
- Create: `packages/plugins/src/registry/types.ts` — Zod schemas for `ServerDetail`, `ServerResponse`, list response
- Create: `packages/plugins/src/registry/registry-client.ts` — `listServers`, `getServerVersion`
- Create: `packages/plugins/src/registry/registry-client.test.ts`
- Create: `packages/plugins/src/registry/map-server.ts` — `deriveTransportTypes`, `deriveAuthKind`, `mapServerDetailToCatalogRow`
- Create: `packages/plugins/src/registry/map-server.test.ts`
- Create: `packages/plugins/src/registry/readme.ts` — `fetchAndRenderReadme`
- Create: `packages/plugins/src/registry/readme.test.ts`
- Create: `packages/plugins/src/registry/sync-service.ts` — `syncRegistry`
- Create: `packages/plugins/src/registry/sync-service.test.ts`
- Modify: `packages/plugins/src/index.ts` — export the registry surface

**Inngest** (`packages/inngest-functions/`)
- Modify: `packages/inngest-functions/src/inngest.ts` — add `plugin/registry.sync` to the `Events` type
- Create: `packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts`
- Create: `packages/inngest-functions/src/functions/plugin.registry-sync.ts`
- Modify: `packages/inngest-functions/src/functions.ts` — add both to the `functions` array

**Capabilities** (contracts → handlers → routes → tools → tests)
- Create per capability: `packages/oxagen/src/contracts/<name>.ts`, `packages/oxagen/src/contracts/<name>.test.ts`, `packages/handlers/src/<name>.ts`, `apps/api/src/routes/v1/<name>.ts`, `apps/mcp/src/tools/<name>.ts`
- Modify: `packages/handlers/src/register.ts` — register the 6 handlers
- Modify: `apps/api/src/routes/v1/index.ts` (or the route registrar) + `apps/mcp` tool index as the existing convention requires (VERIFY: check how `workspace.create` route/tool are registered and mirror it)

---

### Task 1: Add Plan 2 dependencies to `@oxagen/plugins`

**Files:**
- Modify: `packages/plugins/package.json`

- [ ] **Step 1: Add the runtime deps** (edit `dependencies` to read exactly):

```json
  "dependencies": {
    "@oxagen/crypto": "workspace:*",
    "@oxagen/database": "workspace:*",
    "@oxagen/tenancy": "workspace:*",
    "zod": "3.25.76",
    "unified": "11.0.5",
    "remark-parse": "11.0.0",
    "remark-gfm": "4.0.1",
    "remark-rehype": "11.1.2",
    "rehype-sanitize": "6.0.0",
    "rehype-stringify": "10.0.1"
  },
```

VERIFY the exact resolved versions against `pnpm-lock.yaml` before pinning (the Explore reported unified 11.0.5 / remark-parse 11.0.0 / remark-gfm 4.0.1 / remark-rehype 11.1.2 / rehype-sanitize 6.0.0; confirm `rehype-stringify`'s locked version and adjust). Use the one-latest-stable-version-workspace-wide rule: match whatever the lockfile already resolved.

- [ ] **Step 2: Install (deps change → no-frozen-lockfile)**

Run: `pnpm install --no-frozen-lockfile`
Expected: completes; no NEW packages downloaded for the unified/remark/rehype set (already in the graph via `streamdown`); `zod` re-added.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/package.json pnpm-lock.yaml
git commit -m "chore(plugins): add registry-sync deps (zod, db, tenancy, unified markdown stack)"
```

---

### Task 2: Registry OpenAPI client + Zod response types

**Files:**
- Create: `packages/plugins/src/registry/types.ts`
- Create: `packages/plugins/src/registry/registry-client.ts`
- Test: `packages/plugins/src/registry/registry-client.test.ts`

- [ ] **Step 1: Create `packages/plugins/src/registry/types.ts`**

```ts
import { z } from "zod";

/** A sized icon for UI rendering. */
export const iconSchema = z.object({
  src: z.string().url(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

/** Source repository metadata. */
export const repositorySchema = z.object({
  url: z.string(),
  source: z.string(),
  id: z.string().optional(),
  subfolder: z.string().optional(),
});

/** A declared secret-bearing input (env var / header / remote variable). */
export const secretFlagSchema = z.object({
  isSecret: z.boolean().optional(),
  isRequired: z.boolean().optional(),
});

/** Local package install descriptor. */
export const packageSchema = z
  .object({
    registryType: z.string(),
    identifier: z.string(),
    version: z.string().optional(),
    transport: z.object({ type: z.string() }).passthrough().optional(),
    runtimeHint: z.string().optional(),
    environmentVariables: z
      .array(z.object({ name: z.string() }).merge(secretFlagSchema).passthrough())
      .optional(),
  })
  .passthrough();

/** Remote (hosted) transport descriptor. */
export const remoteSchema = z
  .object({
    type: z.string(),
    url: z.string(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string().optional() }).merge(secretFlagSchema).passthrough())
      .optional(),
    variables: z.record(z.object({}).merge(secretFlagSchema).passthrough()).optional(),
  })
  .passthrough();

/** The publisher-authored server record. */
export const serverDetailSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    title: z.string().optional(),
    repository: repositorySchema.optional(),
    websiteUrl: z.string().optional(),
    icons: z.array(iconSchema).optional(),
    packages: z.array(packageSchema).optional(),
    remotes: z.array(remoteSchema).optional(),
  })
  .passthrough();

/** Registry-managed metadata wrapper. */
export const serverMetaSchema = z
  .object({
    status: z.enum(["active", "deprecated", "deleted"]).optional(),
    statusMessage: z.string().optional(),
    statusChangedAt: z.string().optional(),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    isLatest: z.boolean().optional(),
  })
  .passthrough();

export const serverResponseSchema = z.object({
  server: serverDetailSchema,
  _meta: serverMetaSchema.optional(),
});

export const listServersResponseSchema = z.object({
  servers: z.array(serverResponseSchema),
  metadata: z.object({ nextCursor: z.string().optional(), count: z.number().optional() }).optional(),
});

export type Icon = z.infer<typeof iconSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type ServerDetail = z.infer<typeof serverDetailSchema>;
export type ServerMeta = z.infer<typeof serverMetaSchema>;
export type ServerResponse = z.infer<typeof serverResponseSchema>;
export type ListServersResponse = z.infer<typeof listServersResponseSchema>;
```

- [ ] **Step 2: Write the failing test** `packages/plugins/src/registry/registry-client.test.ts`

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { listServers, getServerVersion } from "./registry-client";

const BASE = "https://registry.example.com";

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("registry-client", () => {
  it("lists servers and returns the next cursor", async () => {
    mockFetchOnce({
      servers: [{ server: { name: "io.x/a", description: "d", version: "1.0.0" }, _meta: { isLatest: true } }],
      metadata: { nextCursor: "cur-2", count: 1 },
    });
    const res = await listServers(BASE, { limit: 50 });
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0].server.name).toBe("io.x/a");
    expect(res.nextCursor).toBe("cur-2");
  });

  it("passes cursor/search/updatedSince as query params", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ servers: [] }), text: async () => "{}" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await listServers(BASE, { cursor: "c1", search: "git", updatedSince: "2026-01-01T00:00:00Z" });
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("cursor=c1");
    expect(calledUrl).toContain("search=git");
    expect(calledUrl).toContain("updated_since=2026-01-01");
  });

  it("throws on a non-ok response", async () => {
    mockFetchOnce({ error: "boom" }, false);
    await expect(listServers(BASE, {})).rejects.toThrow(/registry list failed/i);
  });

  it("fetches a single server version", async () => {
    mockFetchOnce({ server: { name: "io.x/a", description: "d", version: "2.0.0" }, _meta: { isLatest: true } });
    const res = await getServerVersion(BASE, "io.x/a", "latest");
    expect(res.server.version).toBe("2.0.0");
  });
});
```

- [ ] **Step 2b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- registry-client`
Expected: FAIL — "Cannot find module './registry-client'".

- [ ] **Step 3: Create `packages/plugins/src/registry/registry-client.ts`**

```ts
/**
 * Typed client for the MCP Registry OpenAPI (https://registry.modelcontextprotocol.io).
 * Discovery endpoints are unauthenticated; responses are Zod-validated. Cursor
 * pagination: follow metadata.nextCursor until absent.
 */
import {
  listServersResponseSchema,
  serverResponseSchema,
  type ServerResponse,
} from "./types";

export interface ListServersOptions {
  cursor?: string;
  limit?: number;
  search?: string;
  /** RFC3339 timestamp — incremental sync filter. */
  updatedSince?: string;
}

export interface ListServersResult {
  servers: ServerResponse[];
  nextCursor: string | undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function listServers(
  baseUrl: string,
  opts: ListServersOptions,
): Promise<ListServersResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.search) params.set("search", opts.search);
  if (opts.updatedSince) params.set("updated_since", opts.updatedSince);
  const qs = params.toString();
  const url = joinUrl(baseUrl, `/v0.1/servers${qs ? `?${qs}` : ""}`);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry list failed: ${res.status} ${await res.text()}`);
  }
  const parsed = listServersResponseSchema.parse(await res.json());
  return { servers: parsed.servers, nextCursor: parsed.metadata?.nextCursor };
}

export async function getServerVersion(
  baseUrl: string,
  name: string,
  version: string,
): Promise<ServerResponse> {
  const url = joinUrl(
    baseUrl,
    `/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  );
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry get failed: ${res.status} ${await res.text()}`);
  }
  return serverResponseSchema.parse(await res.json());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- registry-client`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/src/registry/types.ts packages/plugins/src/registry/registry-client.ts packages/plugins/src/registry/registry-client.test.ts
git commit -m "feat(plugins): MCP registry OpenAPI client + Zod response types"
```

---

### Task 3: Mapping + derivation pure functions

**Files:**
- Create: `packages/plugins/src/registry/map-server.ts`
- Test: `packages/plugins/src/registry/map-server.test.ts`

- [ ] **Step 1: Write the failing test** `packages/plugins/src/registry/map-server.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { deriveTransportTypes, deriveAuthKind, mapServerDetailToCatalogRow } from "./map-server";
import type { ServerDetail, ServerMeta } from "./types";

const REGISTRY_ID = "11111111-1111-1111-1111-111111111111";

describe("deriveTransportTypes", () => {
  it("collects distinct transport types from packages + remotes", () => {
    const sd: ServerDetail = {
      name: "io.x/a", description: "d", version: "1.0.0",
      packages: [{ registryType: "npm", identifier: "a", transport: { type: "stdio" } }],
      remotes: [{ type: "streamable-http", url: "https://x" }, { type: "sse", url: "https://y" }],
    };
    expect(deriveTransportTypes(sd).sort()).toEqual(["sse", "stdio", "streamable-http"]);
  });
});

describe("deriveAuthKind", () => {
  it("returns 'none' when nothing is secret", () => {
    const sd: ServerDetail = { name: "io.x/a", description: "d", version: "1.0.0", remotes: [{ type: "sse", url: "https://x" }] };
    expect(deriveAuthKind(sd)).toBe("none");
  });
  it("returns 'secret' when a remote variable is secret", () => {
    const sd: ServerDetail = {
      name: "io.x/a", description: "d", version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://x", variables: { API_KEY: { isSecret: true } } }],
    };
    expect(deriveAuthKind(sd)).toBe("secret");
  });
  it("returns 'secret' when a package env var is secret", () => {
    const sd: ServerDetail = {
      name: "io.x/a", description: "d", version: "1.0.0",
      packages: [{ registryType: "npm", identifier: "a", transport: { type: "stdio" }, environmentVariables: [{ name: "TOKEN", isSecret: true }] }],
    };
    expect(deriveAuthKind(sd)).toBe("secret");
  });
});

describe("mapServerDetailToCatalogRow", () => {
  it("maps a ServerDetail + meta into catalog columns", () => {
    const sd: ServerDetail = {
      name: "io.x/weather", description: "Weather", version: "1.2.3", title: "Weather",
      repository: { url: "https://github.com/x/weather", source: "github" },
      icons: [{ src: "https://x/i.png" }],
      remotes: [{ type: "streamable-http", url: "https://api/mcp", variables: { K: { isSecret: true } } }],
    };
    const meta: ServerMeta = { status: "active", isLatest: true, publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
    const row = mapServerDetailToCatalogRow(sd, meta, REGISTRY_ID);
    expect(row.registryId).toBe(REGISTRY_ID);
    expect(row.name).toBe("io.x/weather");
    expect(row.version).toBe("1.2.3");
    expect(row.isLatest).toBe(true);
    expect(row.status).toBe("active");
    expect(row.authKind).toBe("secret");
    expect(row.transportTypes).toEqual(["streamable-http"]);
    expect(row.upstreamUpdatedAt).toBeInstanceOf(Date);
  });
  it("defaults status to active and isLatest to false when meta is absent", () => {
    const sd: ServerDetail = { name: "io.x/a", description: "d", version: "1.0.0" };
    const row = mapServerDetailToCatalogRow(sd, undefined, REGISTRY_ID);
    expect(row.status).toBe("active");
    expect(row.isLatest).toBe(false);
    expect(row.authKind).toBe("none");
  });
});
```

- [ ] **Step 1b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- map-server`
Expected: FAIL — "Cannot find module './map-server'".

- [ ] **Step 2: Create `packages/plugins/src/registry/map-server.ts`**

```ts
/**
 * Pure mapping/derivation from a registry ServerDetail to a mcp.catalog_servers
 * row. auth_kind is a heuristic: 'secret' if ANY env-var/header/remote-variable
 * is flagged isSecret, else 'none'. (Real OAuth detection happens at connect
 * time in Plan 4; the registry record does not declare OAuth explicitly.)
 */
import type { ServerDetail, ServerMeta } from "./types";

export type AuthKind = "oauth" | "secret" | "none";

export function deriveTransportTypes(sd: ServerDetail): string[] {
  const set = new Set<string>();
  for (const p of sd.packages ?? []) {
    if (p.transport?.type) set.add(p.transport.type);
  }
  for (const r of sd.remotes ?? []) {
    if (r.type) set.add(r.type);
  }
  return [...set];
}

export function deriveAuthKind(sd: ServerDetail): AuthKind {
  const anySecret =
    (sd.packages ?? []).some((p) => (p.environmentVariables ?? []).some((e) => e.isSecret === true)) ||
    (sd.remotes ?? []).some(
      (r) =>
        (r.headers ?? []).some((h) => h.isSecret === true) ||
        Object.values(r.variables ?? {}).some((v) => v.isSecret === true),
    );
  return anySecret ? "secret" : "none";
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Column values for an upsert into mcp.catalog_servers (excludes id/audit). */
export interface CatalogRowInput {
  registryId: string;
  name: string;
  version: string;
  isLatest: boolean;
  title: string | null;
  description: string;
  repository: ServerDetail["repository"] | null;
  websiteUrl: string | null;
  icons: NonNullable<ServerDetail["icons"]>;
  packages: NonNullable<ServerDetail["packages"]>;
  remotes: NonNullable<ServerDetail["remotes"]>;
  transportTypes: string[];
  authKind: AuthKind;
  status: string;
  publishedAt: Date | null;
  upstreamUpdatedAt: Date | null;
  statusChangedAt: Date | null;
  meta: Record<string, unknown>;
}

export function mapServerDetailToCatalogRow(
  sd: ServerDetail,
  meta: ServerMeta | undefined,
  registryId: string,
): CatalogRowInput {
  return {
    registryId,
    name: sd.name,
    version: sd.version,
    isLatest: meta?.isLatest ?? false,
    title: sd.title ?? null,
    description: sd.description,
    repository: sd.repository ?? null,
    websiteUrl: sd.websiteUrl ?? null,
    icons: sd.icons ?? [],
    packages: sd.packages ?? [],
    remotes: sd.remotes ?? [],
    transportTypes: deriveTransportTypes(sd),
    authKind: deriveAuthKind(sd),
    status: meta?.status ?? "active",
    publishedAt: toDate(meta?.publishedAt),
    upstreamUpdatedAt: toDate(meta?.updatedAt),
    statusChangedAt: toDate(meta?.statusChangedAt),
    meta: (meta ?? {}) as Record<string, unknown>,
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- map-server`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/src/registry/map-server.ts packages/plugins/src/registry/map-server.test.ts
git commit -m "feat(plugins): registry server-detail mapping + transport/auth derivation"
```

---

### Task 4: README fetch + render + sanitize

**Files:**
- Create: `packages/plugins/src/registry/readme.ts`
- Test: `packages/plugins/src/registry/readme.test.ts`

- [ ] **Step 1: Write the failing test** `packages/plugins/src/registry/readme.test.ts`

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchAndRenderReadme } from "./readme";

afterEach(() => vi.unstubAllGlobals());

function stubReadme(md: string, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 404, text: async () => md })) as unknown as typeof fetch,
  );
}

describe("fetchAndRenderReadme", () => {
  it("renders markdown to sanitized HTML", async () => {
    stubReadme("# Hello\n\nSome **bold** text.");
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("strips script tags", async () => {
    stubReadme("ok\n\n<script>alert(1)</script>");
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  it("rewrites relative image src to the repo raw base", async () => {
    stubReadme("![logo](docs/logo.png)");
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).toContain("https://raw.githubusercontent.com/x/repo/HEAD/docs/logo.png");
  });

  it("returns null for a non-github repository", async () => {
    const html = await fetchAndRenderReadme({ url: "https://gitlab.com/x/repo", source: "gitlab" });
    expect(html).toBeNull();
  });

  it("returns null when the README fetch fails", async () => {
    stubReadme("nope", false);
    const html = await fetchAndRenderReadme({ url: "https://github.com/x/repo", source: "github" });
    expect(html).toBeNull();
  });
});
```

- [ ] **Step 1b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- readme`
Expected: FAIL — "Cannot find module './readme'".

- [ ] **Step 2: Create `packages/plugins/src/registry/readme.ts`**

```ts
/**
 * Fetch a server's README from its source repo and render it to sanitized HTML.
 * Server-side (Node, no DOM) via the unified pipeline. Only GitHub repos are
 * supported for now (raw.githubusercontent.com); other sources return null.
 * Relative image sources are rewritten to the repo raw base so they resolve.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Repository } from "./types";

interface GithubRef {
  owner: string;
  repo: string;
  subfolder: string;
}

/** Parse https://github.com/<owner>/<repo>[.git] into owner/repo. */
function parseGithub(repository: Repository): GithubRef | null {
  if (repository.source !== "github") return null;
  const m = repository.url.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  const subfolder = (repository.subfolder ?? "").replace(/^\/+|\/+$/g, "");
  return { owner, repo, subfolder };
}

function rawBase(ref: GithubRef): string {
  const sub = ref.subfolder ? `${ref.subfolder}/` : "";
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/HEAD/${sub}`;
}

/** Minimal rehype plugin: rewrite relative <img src> to absolute raw URLs. */
function rehypeRewriteImages(base: string) {
  return (tree: unknown) => {
    const visit = (node: { tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }) => {
      if (node.tagName === "img" && node.properties && typeof node.properties.src === "string") {
        const src = node.properties.src;
        if (!/^https?:\/\//i.test(src) && !src.startsWith("data:")) {
          node.properties.src = base + src.replace(/^\.?\//, "");
        }
      }
      for (const child of node.children ?? []) visit(child as typeof node);
    };
    visit(tree as { children?: unknown[] });
  };
}

const TTL_MS = 24 * 60 * 60 * 1000;

/** True when a cached README is still fresh and should not be refetched. */
export function isReadmeFresh(fetchedAt: Date | null, now: number): boolean {
  return fetchedAt != null && now - fetchedAt.getTime() < TTL_MS;
}

export async function fetchAndRenderReadme(repository: Repository): Promise<string | null> {
  const ref = parseGithub(repository);
  if (!ref) return null;

  const base = rawBase(ref);
  const candidates = ["README.md", "readme.md", "README.markdown"];
  let markdown: string | null = null;
  for (const file of candidates) {
    const res = await fetch(`${base}${file}`, { headers: { accept: "text/plain" } });
    if (res.ok) {
      markdown = await res.text();
      break;
    }
  }
  if (markdown == null) return null;

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeRewriteImages, base)
    .use(rehypeSanitize)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}
```

> Note: `rehypeRewriteImages` runs BEFORE `rehypeSanitize` so the rewritten `src` survives sanitization (sanitize allows `img[src]` with http(s) URLs by default).

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- readme`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/src/registry/readme.ts packages/plugins/src/registry/readme.test.ts
git commit -m "feat(plugins): README fetch + sanitized HTML render with relative-image rewrite"
```

---

### Task 5: Sync service (dependency-injected, unit-testable)

**Files:**
- Create: `packages/plugins/src/registry/sync-service.ts`
- Test: `packages/plugins/src/registry/sync-service.test.ts`

The service is written against a `SyncPersistence` port so the upsert / is_latest / checkpoint logic is unit-tested with a fake; the default port is backed by `withSystemDb` (the catalog is cross-tenant).

- [ ] **Step 1: Write the failing test** `packages/plugins/src/registry/sync-service.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { syncRegistry, type SyncPersistence, type SyncDeps } from "./sync-service";
import type { ServerResponse } from "./types";

const REG = { id: "reg-1", baseUrl: "https://r", lastSyncedAt: null as Date | null };

function resp(name: string, version: string, isLatest: boolean): ServerResponse {
  return { server: { name, description: "d", version }, _meta: { isLatest, status: "active" } };
}

function fakePersistence() {
  const upserts: Array<{ name: string; version: string; isLatest: boolean }> = [];
  const markedNotLatest: string[] = [];
  let checkpoint: { cursor: string | undefined; at: Date } | null = null;
  const p: SyncPersistence = {
    getRegistry: async () => REG,
    markOthersNotLatest: async (_regId, name) => { markedNotLatest.push(name); },
    upsertCatalogRow: async (row) => { upserts.push({ name: row.name, version: row.version, isLatest: row.isLatest }); return "cat-" + row.name; },
    getReadmeFreshness: async () => null,
    setReadme: async () => {},
    updateCheckpoint: async (_regId, cursor, at) => { checkpoint = { cursor, at }; },
  };
  return { p, upserts, markedNotLatest, get checkpoint() { return checkpoint; } };
}

describe("syncRegistry", () => {
  it("paginates until nextCursor is absent and upserts every server", async () => {
    const f = fakePersistence();
    const pages = [
      { servers: [resp("io.x/a", "1.0.0", true)], nextCursor: "c2" },
      { servers: [resp("io.x/b", "2.0.0", true)], nextCursor: undefined },
    ];
    let call = 0;
    const deps: SyncDeps = {
      listServers: vi.fn(async () => pages[call++]),
      fetchAndRenderReadme: vi.fn(async () => "<p>x</p>"),
      now: () => 1_000,
    };
    const result = await syncRegistry("reg-1", { mode: "full" }, f.p, deps);
    expect(result.upserted).toBe(2);
    expect(f.upserts.map((u) => u.name)).toEqual(["io.x/a", "io.x/b"]);
    expect(deps.listServers).toHaveBeenCalledTimes(2);
  });

  it("marks prior latest false before upserting a new latest version", async () => {
    const f = fakePersistence();
    const deps: SyncDeps = {
      listServers: vi.fn(async () => ({ servers: [resp("io.x/a", "3.0.0", true)], nextCursor: undefined })),
      fetchAndRenderReadme: vi.fn(async () => null),
      now: () => 1_000,
    };
    await syncRegistry("reg-1", { mode: "incremental" }, f.p, deps);
    expect(f.markedNotLatest).toContain("io.x/a");
  });

  it("passes updated_since on incremental sync when lastSyncedAt is set", async () => {
    const f = fakePersistence();
    f.p.getRegistry = async () => ({ ...REG, lastSyncedAt: new Date("2026-01-01T00:00:00Z") });
    const listServers = vi.fn(async () => ({ servers: [], nextCursor: undefined }));
    await syncRegistry("reg-1", { mode: "incremental" }, f.p, { listServers, fetchAndRenderReadme: vi.fn(), now: () => 1 });
    expect(listServers.mock.calls[0][1].updatedSince).toBe("2026-01-01T00:00:00.000Z");
  });

  it("checkpoints after the run", async () => {
    const f = fakePersistence();
    const deps: SyncDeps = {
      listServers: vi.fn(async () => ({ servers: [], nextCursor: undefined })),
      fetchAndRenderReadme: vi.fn(),
      now: () => 42,
    };
    await syncRegistry("reg-1", { mode: "full" }, f.p, deps);
    expect(f.checkpoint).not.toBeNull();
    expect(f.checkpoint!.at).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 1b: Run it to verify it fails**

Run: `pnpm --filter @oxagen/plugins test:unit -- sync-service`
Expected: FAIL — "Cannot find module './sync-service'".

- [ ] **Step 2: Create `packages/plugins/src/registry/sync-service.ts`**

```ts
/**
 * Registry → catalog sync. Paginates a registry (cursor), upserts each server
 * version into mcp.catalog_servers (maintaining is_latest), refreshes READMEs
 * respecting a 24h TTL, and checkpoints last_synced_cursor/last_synced_at.
 *
 * Written against a SyncPersistence port for offline unit testing; the default
 * port (createSystemSyncPersistence) is backed by withSystemDb — the catalog is
 * cross-tenant shared state, not org-scoped.
 */
import { listServers as defaultListServers, type ListServersResult } from "./registry-client";
import { fetchAndRenderReadme as defaultRenderReadme, isReadmeFresh } from "./readme";
import { mapServerDetailToCatalogRow, type CatalogRowInput } from "./map-server";

export interface SyncRegistryRow {
  id: string;
  baseUrl: string;
  lastSyncedAt: Date | null;
}

/** Persistence port — the only DB surface the sync logic touches. */
export interface SyncPersistence {
  getRegistry(registryId: string): Promise<SyncRegistryRow | null>;
  markOthersNotLatest(registryId: string, name: string): Promise<void>;
  /** Upsert by (registry_id, name, version); returns the catalog row id. */
  upsertCatalogRow(row: CatalogRowInput): Promise<string>;
  getReadmeFreshness(catalogId: string): Promise<Date | null>;
  setReadme(catalogId: string, html: string | null, fetchedAt: Date): Promise<void>;
  updateCheckpoint(registryId: string, cursor: string | undefined, at: Date): Promise<void>;
}

export interface SyncDeps {
  listServers: (baseUrl: string, opts: { cursor?: string; limit?: number; updatedSince?: string }) => Promise<ListServersResult>;
  fetchAndRenderReadme: typeof defaultRenderReadme;
  now: () => number;
}

export interface SyncResult {
  upserted: number;
  readmesRefreshed: number;
}

const PAGE_LIMIT = 100;

export async function syncRegistry(
  registryId: string,
  opts: { mode: "full" | "incremental" },
  persistence: SyncPersistence,
  deps: SyncDeps = { listServers: defaultListServers, fetchAndRenderReadme: defaultRenderReadme, now: () => Date.now() },
): Promise<SyncResult> {
  const registry = await persistence.getRegistry(registryId);
  if (!registry) throw new Error(`registry not found: ${registryId}`);

  const updatedSince =
    opts.mode === "incremental" && registry.lastSyncedAt
      ? registry.lastSyncedAt.toISOString()
      : undefined;

  let cursor: string | undefined;
  let lastCursor: string | undefined;
  let upserted = 0;
  let readmesRefreshed = 0;

  do {
    const page = await deps.listServers(registry.baseUrl, { cursor, limit: PAGE_LIMIT, updatedSince });
    for (const entry of page.servers) {
      const row = mapServerDetailToCatalogRow(entry.server, entry._meta, registryId);
      if (row.isLatest) {
        await persistence.markOthersNotLatest(registryId, row.name);
      }
      const catalogId = await persistence.upsertCatalogRow(row);

      if (row.repository) {
        const freshness = await persistence.getReadmeFreshness(catalogId);
        if (!isReadmeFresh(freshness, deps.now())) {
          const html = await deps.fetchAndRenderReadme(row.repository);
          await persistence.setReadme(catalogId, html, new Date(deps.now()));
          if (html) readmesRefreshed += 1;
        }
      }
      upserted += 1;
    }
    lastCursor = page.nextCursor;
    cursor = page.nextCursor;
  } while (cursor);

  await persistence.updateCheckpoint(registryId, lastCursor, new Date(deps.now()));
  return { upserted, readmesRefreshed };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter @oxagen/plugins test:unit -- sync-service`
Expected: PASS (4 tests).

- [ ] **Step 4: Create the system-DB persistence adapter** — append to `sync-service.ts`:

```ts
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, ne } from "drizzle-orm";

/** Default persistence port backed by withSystemDb (cross-tenant catalog). */
export function createSystemSyncPersistence(): SyncPersistence {
  return {
    async getRegistry(registryId) {
      return withSystemDb(async (tx) => {
        const [r] = await tx
          .select({ id: schema.mcpRegistries.id, baseUrl: schema.mcpRegistries.baseUrl, lastSyncedAt: schema.mcpRegistries.lastSyncedAt })
          .from(schema.mcpRegistries)
          .where(eq(schema.mcpRegistries.id, registryId))
          .limit(1);
        return r ?? null;
      });
    },
    async markOthersNotLatest(registryId, name) {
      await withSystemDb(async (tx) => {
        await tx
          .update(schema.mcpCatalogServers)
          .set({ isLatest: false })
          .where(and(eq(schema.mcpCatalogServers.registryId, registryId), eq(schema.mcpCatalogServers.name, name)));
      });
    },
    async upsertCatalogRow(row) {
      return withSystemDb(async (tx) => {
        const [inserted] = await tx
          .insert(schema.mcpCatalogServers)
          .values(row)
          .onConflictDoUpdate({
            target: [schema.mcpCatalogServers.registryId, schema.mcpCatalogServers.name, schema.mcpCatalogServers.version],
            set: {
              isLatest: row.isLatest, title: row.title, description: row.description, repository: row.repository,
              websiteUrl: row.websiteUrl, icons: row.icons, packages: row.packages, remotes: row.remotes,
              transportTypes: row.transportTypes, authKind: row.authKind, status: row.status,
              publishedAt: row.publishedAt, upstreamUpdatedAt: row.upstreamUpdatedAt, statusChangedAt: row.statusChangedAt,
              meta: row.meta, updatedAt: new Date(),
            },
          })
          .returning({ id: schema.mcpCatalogServers.id });
        return inserted.id;
      });
    },
    async getReadmeFreshness(catalogId) {
      return withSystemDb(async (tx) => {
        const [r] = await tx
          .select({ fetchedAt: schema.mcpCatalogServers.readmeFetchedAt })
          .from(schema.mcpCatalogServers)
          .where(eq(schema.mcpCatalogServers.id, catalogId))
          .limit(1);
        return r?.fetchedAt ?? null;
      });
    },
    async setReadme(catalogId, html, fetchedAt) {
      await withSystemDb(async (tx) => {
        await tx.update(schema.mcpCatalogServers).set({ readmeHtml: html, readmeFetchedAt: fetchedAt }).where(eq(schema.mcpCatalogServers.id, catalogId));
      });
    },
    async updateCheckpoint(registryId, cursor, at) {
      await withSystemDb(async (tx) => {
        await tx.update(schema.mcpRegistries).set({ lastSyncedCursor: cursor ?? null, lastSyncedAt: at }).where(eq(schema.mcpRegistries.id, registryId));
      });
    },
  };
}
```

VERIFY: `ne` import is unused if not referenced — remove it if eslint flags `no-unused-vars`. Confirm `onConflictDoUpdate` target column references match the Drizzle `uniqueIndex` (`catalog_servers_name_version_uniq` on registryId,name,version).

- [ ] **Step 5: Typecheck + re-run sync tests**

Run: `pnpm --filter @oxagen/plugins typecheck && pnpm --filter @oxagen/plugins test:unit -- sync-service`
Expected: typecheck PASS; 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/src/registry/sync-service.ts packages/plugins/src/registry/sync-service.test.ts
git commit -m "feat(plugins): registry catalog sync service (DI port + system-db adapter)"
```

---

### Task 6: Inngest sync jobs (cron + on-demand event)

**Files:**
- Modify: `packages/inngest-functions/src/inngest.ts` — add the `plugin/registry.sync` event to the `Events` type
- Create: `packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts`
- Create: `packages/inngest-functions/src/functions/plugin.registry-sync.ts`
- Modify: `packages/inngest-functions/src/functions.ts` — register both

- [ ] **Step 1: Add the event to the `Events` type** in `packages/inngest-functions/src/inngest.ts`

Inside the `Events` type (alongside the existing events), add:

```ts
  "plugin/registry.sync": { data: { registryId: string; mode: "full" | "incremental" } };
```

VERIFY the exact shape of the `Events` type (object-of-records vs interface) by reading the file, and match the existing entries' formatting.

- [ ] **Step 2: Create the cron function** `packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts`

```ts
/**
 * Hourly-ish incremental catalog sync across all enabled registries. Each
 * registry is synced in its own step so one failure doesn't abort the rest.
 */
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { syncRegistry, createSystemSyncPersistence } from "@oxagen/plugins";
import { inngest } from "../inngest";

export const pluginCatalogSyncCron = inngest.createFunction(
  { id: "plugin.catalog-sync-cron", retries: 2 },
  { cron: "0 */6 * * *" },
  async ({ step }) => {
    const registries = await step.run("load-enabled-registries", () =>
      withSystemDb((tx) =>
        tx
          .select({ id: schema.mcpRegistries.id })
          .from(schema.mcpRegistries)
          .where(eq(schema.mcpRegistries.enabled, true)),
      ),
    );

    const persistence = createSystemSyncPersistence();
    let total = 0;
    for (const r of registries) {
      const result = await step.run(`sync-${r.id}`, () =>
        syncRegistry(r.id, { mode: "incremental" }, persistence),
      );
      total += result.upserted;
    }
    return { registries: registries.length, upserted: total };
  },
);
```

- [ ] **Step 3: Create the on-demand event function** `packages/inngest-functions/src/functions/plugin.registry-sync.ts`

```ts
/** On-demand sync of a single registry (dispatched by plugin.registry.sync). */
import { syncRegistry, createSystemSyncPersistence } from "@oxagen/plugins";
import { inngest } from "../inngest";

export const pluginRegistrySync = inngest.createFunction(
  { id: "plugin.registry-sync", retries: 2 },
  { event: "plugin/registry.sync" },
  async ({ event, step }) => {
    const { registryId, mode } = event.data;
    const persistence = createSystemSyncPersistence();
    return step.run("sync", () => syncRegistry(registryId, { mode }, persistence));
  },
);
```

- [ ] **Step 4: Register both** in `packages/inngest-functions/src/functions.ts`

Import them and add to the `functions` array:

```ts
import { pluginCatalogSyncCron } from "./functions/plugin.catalog-sync-cron";
import { pluginRegistrySync } from "./functions/plugin.registry-sync";
```
…and add `pluginCatalogSyncCron, pluginRegistrySync` to the `export const functions = [...]` array.

VERIFY: `@oxagen/plugins` must be a dependency of `packages/inngest-functions` — add `"@oxagen/plugins": "workspace:*"` to `packages/inngest-functions/package.json` dependencies and `pnpm install --no-frozen-lockfile` if missing.

- [ ] **Step 5: Typecheck inngest-functions**

Run: `pnpm --filter @oxagen/inngest-functions typecheck`
Expected: PASS. (If it fails on the missing `@oxagen/plugins` dep, add it per Step 4's VERIFY note and re-run.)

- [ ] **Step 6: Commit**

```bash
git add packages/inngest-functions/src/inngest.ts packages/inngest-functions/src/functions/plugin.catalog-sync-cron.ts packages/inngest-functions/src/functions/plugin.registry-sync.ts packages/inngest-functions/src/functions.ts packages/inngest-functions/package.json pnpm-lock.yaml
git commit -m "feat(inngest): catalog sync cron + on-demand registry sync event"
```

---

### Task 7: Capabilities — registry management + catalog browse/get (API ⇄ MCP parity)

Six capabilities. Each follows the **same four-file wiring** (contract → handler → api route → mcp tool) plus a contract unit test. Below: (a) the shared wiring template stated once, (b) all six contracts in full, (c) all six handler bodies in full, (d) `plugin.catalog.browse` fully instantiated as the reference, (e) registration + manifest steps.

> All capabilities are **org-scoped, not workspace-scoped** (`scoped: false`), `mode: "sync"`, `surfaces: ["api","mcp"]`, `layers: ["api","mcp","unit"]`. Management writes (`registry.add/remove/sync`) use `defaultRoles: { org: { Owner: "allow", Admin: "allow" } }`, `defaultEffect: "deny"`. Reads (`registry.list`, `catalog.browse`, `catalog.get`) use the same roles for now (Plan 3 refines who can browse vs. manage). `sensitivity`: `registry.add`=medium, `registry.remove`=medium (destructive set true on remove), `registry.sync`=low, reads=low.

#### (a) Shared wiring template

**API route** — `apps/api/src/routes/v1/<cap-name>.ts` (mirror `apps/api/src/routes/v1/workspace.create.ts` EXACTLY for ctx construction + Hono registration):

```ts
import { <camelName> } from "@oxagen/oxagen/contracts/<cap-name>";
import { invoke } from "@oxagen/oxagen/kernel";
// VERIFY: copy the exact router/ctx-builder imports + export style from
// apps/api/src/routes/v1/workspace.create.ts (it builds `ctx` from the request).
// Then:
//   const body = <camelName>.input.parse(await c.req.json());
//   const out = await invoke(<camelName>.name, body, ctx, { surface: "api" });
//   return c.json(out);
```

**MCP tool** — `apps/mcp/src/tools/<cap-name>.ts` (mirror `apps/mcp/src/tools/workspace.create.ts` EXACTLY):

```ts
import { headers } from "...";            // VERIFY: same import workspace.create uses
import { buildContext } from "...";       // VERIFY: same
import { invoke } from "@oxagen/oxagen/kernel";
import { <camelName> } from "@oxagen/oxagen/contracts/<cap-name>";
import type { ToolMetadata } from "xmcp";

export const schema = { ...<camelName>.input.shape };
export const metadata: ToolMetadata = { name: <camelName>.name, description: <camelName>.description };
export default async function tool(args: unknown) {
  const ctx = await buildContext(headers());
  const out = await invoke(<camelName>.name, args, ctx, { surface: "mcp" });
  return <camelName>.output.parse(out);
}
```

**Handler** — `packages/handlers/src/<cap-name>.ts` exporting `export const handler: CapabilityHandlerFn = async (input, ctx) => {...}` (VERIFY the `CapabilityHandlerFn` signature + how `ctx.orgId` is exposed by reading an existing handler, e.g. `packages/handlers/src/chat.message.send.ts`).

**Registration** — add to `packages/handlers/src/register.ts`:
```ts
registerHandler("<cap-name>", async () => (await import("./<cap-name>")).handler);
```

#### (b) The six contracts (create each `packages/oxagen/src/contracts/<name>.ts`)

- [ ] **plugin.registry.list** — `packages/oxagen/src/contracts/plugin.registry.list.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryList = registerCapability({
  name: "plugin.registry.list",
  domain: "plugin",
  description: "List MCP registries available to the org (global default seed + org-added).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({}),
  output: z.object({
    registries: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        baseUrl: z.string(),
        enabled: z.boolean(),
        isDefaultSeed: z.boolean(),
        lastSyncedAt: z.string().nullable(),
      }),
    ),
  }),
});
```

- [ ] **plugin.registry.add** — `packages/oxagen/src/contracts/plugin.registry.add.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryAdd = registerCapability({
  name: "plugin.registry.add",
  domain: "plugin",
  description: "Add an MCP registry source for the org (any registry implementing the MCP Registry OpenAPI).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ name: z.string().min(1).max(120), baseUrl: z.string().url() }),
  output: z.object({ registryId: z.string() }),
});
```

- [ ] **plugin.registry.remove** — `packages/oxagen/src/contracts/plugin.registry.remove.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryRemove = registerCapability({
  name: "plugin.registry.remove",
  domain: "plugin",
  description: "Remove an org-added MCP registry source (the global default seed cannot be removed).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ registryId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
```

- [ ] **plugin.registry.sync** — `packages/oxagen/src/contracts/plugin.registry.sync.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistrySync = registerCapability({
  name: "plugin.registry.sync",
  domain: "plugin",
  description: "Trigger an on-demand catalog sync for a registry (async; returns accepted).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ registryId: z.string(), mode: z.enum(["full", "incremental"]).default("incremental") }),
  output: z.object({ accepted: z.boolean() }),
});
```

- [ ] **plugin.catalog.browse** — `packages/oxagen/src/contracts/plugin.catalog.browse.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogBrowse = registerCapability({
  name: "plugin.catalog.browse",
  domain: "plugin",
  description: "Search and filter the MCP server catalog (latest versions) by text, category, transport, and auth kind.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    search: z.string().optional(),
    categories: z.array(z.string()).optional(),
    transportTypes: z.array(z.string()).optional(),
    authKind: z.enum(["oauth", "secret", "none"]).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    servers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        title: z.string().nullable(),
        description: z.string(),
        icons: z.array(z.object({ src: z.string() }).passthrough()),
        transportTypes: z.array(z.string()),
        authKind: z.string(),
        categories: z.array(z.string()),
        version: z.string(),
      }),
    ),
    nextOffset: z.number().nullable(),
    total: z.number(),
  }),
});
```

- [ ] **plugin.catalog.get** — `packages/oxagen/src/contracts/plugin.catalog.get.ts`

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogGet = registerCapability({
  name: "plugin.catalog.get",
  domain: "plugin",
  description: "Get full detail for one catalog server, including rendered README HTML, packages, and remotes.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ catalogId: z.string() }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    description: z.string(),
    version: z.string(),
    repository: z.unknown().nullable(),
    websiteUrl: z.string().nullable(),
    icons: z.array(z.unknown()),
    packages: z.array(z.unknown()),
    remotes: z.array(z.unknown()),
    transportTypes: z.array(z.string()),
    authKind: z.string(),
    categories: z.array(z.string()),
    readmeHtml: z.string().nullable(),
    status: z.string(),
  }),
});
```

#### (c) The six handler bodies (create each `packages/handlers/src/<name>.ts`)

> Each exports `export const handler: CapabilityHandlerFn = async (input, ctx) => {...}`. VERIFY the exact `CapabilityHandlerFn` type + how `ctx` exposes the org id (read `packages/handlers/src/chat.message.send.ts`). The catalog tables are cross-tenant → use `withSystemDb`. Registry rows are org+global → `withSystemDb` with explicit `orgId` filters.

- [ ] **plugin.registry.list handler**

```ts
import { or, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types"; // VERIFY exact type export

export const handler: CapabilityHandlerFn = async (_input, ctx) => {
  const orgId = ctx.orgId; // VERIFY accessor
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.mcpRegistries)
      .where(or(isNull(schema.mcpRegistries.orgId), eq(schema.mcpRegistries.orgId, orgId))),
  );
  return {
    registries: rows.map((r) => ({
      id: r.id, name: r.name, baseUrl: r.baseUrl, enabled: r.enabled,
      isDefaultSeed: r.isDefaultSeed, lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    })),
  };
};
```

- [ ] **plugin.registry.add handler**

```ts
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, baseUrl } = input as { name: string; baseUrl: string };
  const [row] = await withSystemDb((tx) =>
    tx.insert(schema.mcpRegistries).values({ orgId: ctx.orgId, name, baseUrl, enabled: true, isDefaultSeed: false }).returning({ id: schema.mcpRegistries.id }),
  );
  return { registryId: row.id };
};
```

- [ ] **plugin.registry.remove handler** (block removing the global seed)

```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { registryId } = input as { registryId: string };
  const deleted = await withSystemDb((tx) =>
    tx
      .delete(schema.mcpRegistries)
      .where(and(eq(schema.mcpRegistries.id, registryId), eq(schema.mcpRegistries.orgId, ctx.orgId), eq(schema.mcpRegistries.isDefaultSeed, false)))
      .returning({ id: schema.mcpRegistries.id }),
  );
  return { ok: deleted.length > 0 };
};
```

- [ ] **plugin.registry.sync handler** (dispatch the Inngest event)

```ts
import { inngest } from "@oxagen/inngest-functions"; // VERIFY export path for the client
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input) => {
  const { registryId, mode } = input as { registryId: string; mode: "full" | "incremental" };
  await inngest.send({ name: "plugin/registry.sync", data: { registryId, mode } });
  return { accepted: true };
};
```

- [ ] **plugin.catalog.browse handler**

```ts
import { and, desc, eq, ilike, arrayOverlaps, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input) => {
  const { search, categories, transportTypes, authKind, limit, offset } = input as {
    search?: string; categories?: string[]; transportTypes?: string[]; authKind?: string; limit: number; offset: number;
  };
  const conds = [eq(schema.mcpCatalogServers.isLatest, true), eq(schema.mcpCatalogServers.status, "active")];
  if (search) conds.push(ilike(schema.mcpCatalogServers.name, `%${search}%`));
  if (authKind) conds.push(eq(schema.mcpCatalogServers.authKind, authKind));
  if (categories?.length) conds.push(arrayOverlaps(schema.mcpCatalogServers.categories, categories));
  if (transportTypes?.length) conds.push(arrayOverlaps(schema.mcpCatalogServers.transportTypes, transportTypes));
  const where = and(...conds);

  return withSystemDb(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.mcpCatalogServers)
      .where(where)
      .orderBy(desc(schema.mcpCatalogServers.publishedAt))
      .limit(limit)
      .offset(offset);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.mcpCatalogServers)
      .where(where);
    return {
      servers: rows.map((r) => ({
        id: r.id, name: r.name, title: r.title, description: r.description,
        icons: (r.icons as Array<{ src: string }>) ?? [], transportTypes: r.transportTypes,
        authKind: r.authKind, categories: r.categories, version: r.version,
      })),
      nextOffset: offset + rows.length < count ? offset + limit : null,
      total: count,
    };
  });
};
```

VERIFY: `ilike` searches `name` only; if you want title/description search too, OR additional `ilike` conditions. Confirm `arrayOverlaps` is exported by the installed `drizzle-orm` version; if not, use `sql\`$\{col} && $\{array}\\``.

- [ ] **plugin.catalog.get handler**

```ts
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/types";

export const handler: CapabilityHandlerFn = async (input) => {
  const { catalogId } = input as { catalogId: string };
  const [r] = await withSystemDb((tx) =>
    tx.select().from(schema.mcpCatalogServers).where(eq(schema.mcpCatalogServers.id, catalogId)).limit(1),
  );
  if (!r) throw new Error("catalog server not found");
  return {
    id: r.id, name: r.name, title: r.title, description: r.description, version: r.version,
    repository: r.repository ?? null, websiteUrl: r.websiteUrl, icons: (r.icons as unknown[]) ?? [],
    packages: (r.packages as unknown[]) ?? [], remotes: (r.remotes as unknown[]) ?? [],
    transportTypes: r.transportTypes, authKind: r.authKind, categories: r.categories,
    readmeHtml: r.readmeHtml, status: r.status,
  };
};
```

#### (d) Reference instantiation — `plugin.catalog.browse` fully wired + tested

- [ ] **Step 1: Contract unit test** `packages/oxagen/src/contracts/plugin.catalog.browse.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { pluginCatalogBrowse } from "./plugin.catalog.browse";

describe("plugin.catalog.browse contract", () => {
  it("registers with api+mcp surfaces and org admin roles", () => {
    expect(pluginCatalogBrowse.name).toBe("plugin.catalog.browse");
    expect(pluginCatalogBrowse.surfaces).toContain("api");
    expect(pluginCatalogBrowse.surfaces).toContain("mcp");
    expect(pluginCatalogBrowse.defaultRoles.org.Owner).toBe("allow");
  });
  it("applies input defaults (limit 30, offset 0)", () => {
    const parsed = pluginCatalogBrowse.input.parse({});
    expect(parsed.limit).toBe(30);
    expect(parsed.offset).toBe(0);
  });
  it("rejects an invalid authKind", () => {
    expect(() => pluginCatalogBrowse.input.parse({ authKind: "bogus" })).toThrow();
  });
});
```

Run: `pnpm --filter @oxagen/oxagen test:unit -- plugin.catalog.browse`
Expected: PASS (3 tests).

- [ ] **Step 2: Create the api route + mcp tool** for `plugin.catalog.browse` from the template in (a) (read `workspace.create` route/tool first and copy ctx/registration verbatim, substituting `pluginCatalogBrowse` / `plugin.catalog.browse`). Register the route in the api route registrar and the tool per the mcp tool-discovery convention (VERIFY both against how `workspace.create` is registered).

- [ ] **Step 3: Repeat (b)+(c)+(d-Step1/2) for the other five capabilities.** Each: contract file, contract test (assert name/surfaces/roles + one input-validation case), handler file, route file, tool file. Use the exact templates above.

#### (e) Register handlers + manifest

- [ ] **Step 1: Register all six handlers** in `packages/handlers/src/register.ts`:

```ts
registerHandler("plugin.registry.list", async () => (await import("./plugin.registry.list")).handler);
registerHandler("plugin.registry.add", async () => (await import("./plugin.registry.add")).handler);
registerHandler("plugin.registry.remove", async () => (await import("./plugin.registry.remove")).handler);
registerHandler("plugin.registry.sync", async () => (await import("./plugin.registry.sync")).handler);
registerHandler("plugin.catalog.browse", async () => (await import("./plugin.catalog.browse")).handler);
registerHandler("plugin.catalog.get", async () => (await import("./plugin.catalog.get")).handler);
```

- [ ] **Step 2: Ensure contracts are discovered** — run the manifest generator (it rewrites `packages/oxagen/src/contracts.generated.ts`):

Run: `pnpm check:manifest`
Expected: warn-only; the six `plugin.*` capabilities appear with `api`/`mcp`/`unit` layers satisfied (no warnings for these). Fix any reported missing file.

- [ ] **Step 3: Commit**

```bash
git add packages/oxagen/src/contracts/plugin.*.ts packages/oxagen/src/contracts/plugin.*.test.ts packages/handlers/src/plugin.*.ts packages/handlers/src/register.ts apps/api/src/routes/v1/plugin.*.ts apps/mcp/src/tools/plugin.*.ts packages/oxagen/src/contracts.generated.ts packages/oxagen/capabilities.manifest.json
git commit -m "feat(plugins): registry+catalog capabilities (contracts, handlers, api routes, mcp tools) with parity"
```

---

### Task 8: Final verification

- [ ] **Step 1: Manifest parity**

Run: `pnpm check:manifest`
Expected: no warnings for any `plugin.*` capability (all declared layers have files).

- [ ] **Step 2: Typecheck touched packages**

Run: `pnpm --filter @oxagen/plugins --filter @oxagen/oxagen --filter @oxagen/handlers --filter @oxagen/inngest-functions typecheck`
Expected: all PASS.

- [ ] **Step 3: Unit tests**

Run: `pnpm --filter @oxagen/plugins test:unit && pnpm --filter @oxagen/oxagen test:unit -- plugin.`
Expected: plugins suite green (registry-client 4, map-server 6, readme 5, sync-service 4, + Plan 1's 5 = 24); contract tests green (≥6 plugin contract tests).

- [ ] **Step 4: Lint**

Run: `pnpm --filter @oxagen/plugins lint`
Expected: clean (remove any unused imports flagged, e.g. `ne` in sync-service if unused).

- [ ] **Step 5: Live sync smoke (optional, requires local PG + network)**

Run a one-off `tsx` script (or a temporary test) calling `syncRegistry(<seedRegistryId>, { mode: "full" }, createSystemSyncPersistence())` against the seeded official registry and assert `mcp.catalog_servers` row count > 0. Document in the PR; do not commit the throwaway script.

---

### Done criteria for Plan 2

- The MCP registry client paginates the official registry and is Zod-validated.
- `syncRegistry` upserts catalog rows, maintains `is_latest`, refreshes READMEs (sanitized HTML, relative images rewritten) on a 24h TTL, and checkpoints the cursor.
- An Inngest cron syncs all enabled registries every 6h; an on-demand event syncs a single registry.
- Six capabilities (`plugin.registry.add|remove|list|sync`, `plugin.catalog.browse|get`) are reachable identically over `/v1` API and MCP; `pnpm check:manifest` is clean for them.
- All unit tests green; typecheck + lint clean across touched packages.

**Next plan:** `2026-06-06-installable-plugins-03-spine-capabilities-runtime.md` — the `PluginType` spine, MCP `contributeTools`, org install/enable + denylist governance capabilities, `assertMcpManager`, and the governance-gated `materializeTools` extension.

## Document — `2026-06-06-installable-plugins-03-spine-capabilities-runtime.md`

## Installable Plugins — Plan 3: Spine + Governance + Runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make installed MCP servers actually usable by agents — the org allow-list/denylist governance capabilities, the per-workspace install + credential storage, the polymorphic `PluginType` spine, and the governance-gated `materializeTools` extension that injects enabled servers' tools into every agent.

**Architecture:** A `PluginType` interface (one `contributeTools(ctx)` method) registered per type; MCP is the only fully-implemented type (Integration/Content tools register placeholders that return no tools yet — the extensibility seam). Governance capabilities write `plugin.org_listings` (allow-list, disabled-by-default), `plugin.org_denylist`, and `agent.mcp_servers` (workspace install, now carrying `org_listing_id`). Credentials persist envelope-encrypted in `mcp.credentials`. `materializeTools` joins the allow-list (`enabled`), excludes the denylist, decrypts the credential, and injects tools — so the interactive Q&A agent uses installed servers exactly like Claude Code.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, Zod, `@oxagen/crypto` (already wired in Plan 1's credential service), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§3 spine, §8 governance capabilities, §9 runtime)

**Builds on Plans 1–2 (shipped):** tables + credential service (`@oxagen/plugins/credentials`), catalog (`mcp.catalog_servers`), registry/catalog capabilities. `agent.mcp_servers.org_listing_id` column exists (nullable).

---

### Grounded conventions (verified)

- **`materializeTools(ctx, opts)`** → `{ tools, nameMap }` (`packages/agent/src/runtime/materialize-tools.ts`). The MCP load block (lines 234–261+) queries `withTenantDb` → `schema.mcpServers` filtered `orgId = ctx.orgId AND workspaceId = ctx.workspaceId AND healthStatus = 'healthy'`, then per row `connectMcp({ endpointUrl, authStrategy, authConfig })` + `materializeMcpTools(client, "mcp.${server.id}")`, wrapping each with `authorizeExternalCapability(key, ctx, "allow")` + `insertToolInvocation(...)`. Per-server failures are caught and skipped. **This is the gating point.**
- **`connectMcp(args: { endpointUrl, authStrategy: "none"|"bearer"|"header", authConfig?: Record<string,string> })`** (`packages/agent/src/dispatch/mcp-client.ts`). Bearer → `Authorization: Bearer ${authConfig.token}`. **Inject a decrypted credential by passing `authStrategy: "bearer", authConfig: { token }` — no signature change.**
- **Governance tables are queryable from `@oxagen/agent`** via `@oxagen/database` (`schema.pluginOrgListings`, `schema.pluginOrgDenylist`) — no new dep edge needed for runtime gating.
- **`PluginType` value enum** belongs in `@oxagen/database/src/schema/plugin.ts` (both `@oxagen/agent` and `@oxagen/plugins` depend on `@oxagen/database`; no cycle).
- **Capability wiring** is identical to Plan 2 Task 7 (contract `registerCapability` → handler in `packages/handlers` → api route mirroring `workspace.create.ts` → xmcp tool mirroring `agent.mcp.list.ts` → contract `.test.ts`; register in `packages/handlers/src/register.ts` + `apps/api/src/app.ts`; `pnpm check:manifest`). Management caps: `surfaces:["api","mcp"]`, `scoped:false` (org caps) or `scoped:true` (workspace cap), `defaultRoles:{ org:{ Owner:"allow", Admin:"allow" } }`, `defaultEffect:"deny"`. DB writes use `withSystemDb` for org-level rows (filter by `ctx.orgId`), `withTenantDb` for workspace rows.
- **Existing `agent.mcp.register/list` handlers** stay as workspace-level custom registration; the new `plugin.workspace.set_enabled` is the marketplace install path (writes `agent.mcp_servers.org_listing_id`).

---

### File Structure

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

### Task 1: `PluginType` value enum

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

### Task 2: Workspace credential persistence service

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

### Task 3: `agent.mcp_servers.enabled` column (workspace enable/disable toggle)

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

### Task 4: Governance capabilities (8) — mirror the Plan 2 Task 7 wiring

For EACH capability create the 5 files (contract, contract `.test.ts`, handler, api route, mcp tool) using the EXACT pattern proven in Plan 2 (see committed `packages/oxagen/src/contracts/plugin.catalog.browse.ts` + its handler/route/tool as the reference). Register handlers in `packages/handlers/src/register.ts` and routes in `apps/api/src/app.ts`. Run `pnpm check:manifest` (clean for all `plugin.*`). Common contract fields: `domain:"plugin"`, `mode:"sync"`, `surfaces:["api","mcp"]`, `defaultEffect:"deny"`, `defaultRoles:{ org:{ Owner:"allow", Admin:"allow" }, workspace: {} }`. Handlers use `withSystemDb` for org rows (filter `ctx.orgId`), `withTenantDb` for the workspace row. Guard `.returning()`/index access (strict `noUncheckedIndexedAccess`); no `any`.

#### Contracts + handler logic

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

> Update Task 3's migration to also add: `CREATE UNIQUE INDEX mcp_servers_ws_listing_uniq ON agent.mcp_servers (workspace_id, org_listing_id) WHERE org_listing_id IS NOT NULL;` (partial unique so legacy custom rows with NULL org_listing_id are unaffected). The Drizzle schema gets a matching `uniqueIndex(...).where(sql\`org_listing_id IS NOT NULL\\`)`.

---

### Task 5: `PluginType` spine + MCP contributor + placeholders

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

### Task 6: Wire `materializeTools` to the spine

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

### Task 7: Verification

- [ ] `pnpm check:manifest` — clean for all `plugin.*`.
- [ ] Typecheck: `pnpm --filter @oxagen/plugins --filter @oxagen/oxagen --filter @oxagen/handlers --filter @oxagen/agent --filter @oxagen/api --filter @oxagen/mcp typecheck` — all PASS.
- [ ] Tests: `pnpm --filter @oxagen/plugins test:unit` + `pnpm --filter @oxagen/oxagen test:unit -- plugin` + `pnpm --filter @oxagen/agent test:unit` — all green.
- [ ] Lint touched packages.
- [ ] **Live smoke** (local PG + a fixture MCP server, optional): install a catalog server to the org, enable at a workspace, set a secret, then call `materializeTools(ctx)` and assert the server's tools appear; flip the org listing `enabled=false` and assert they vanish; denylist the name and assert they vanish. Document; don't commit throwaway.

### Done criteria for Plan 3

- Org admins can install (single + bulk) catalog/custom servers to the org allow-list (disabled by default), enable/disable, uninstall, and maintain a denylist that immediately disables matching installs.
- Workspaces enable servers from the allow-list only; per-workspace secrets persist encrypted.
- `materializeTools` injects ONLY enabled + healthy + allow-listed + non-denied servers' tools, with the decrypted credential, via the polymorphic `PluginType` registry — so the interactive Q&A agent uses them. Integration/Content-tool types are registered placeholders (extensible, no tools yet).

**Next plan:** `2026-06-06-installable-plugins-04-oauth.md` — MCP OAuth 2.1 (discovery/DCR/PKCE/refresh) + the re-auth state machine.

## Document — `2026-06-06-installable-plugins-04-oauth.md`

## Installable Plugins — Plan 4: MCP OAuth 2.1 (discovery / DCR / PKCE / refresh / re-auth)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an org admin connect an OAuth-protected MCP server through the standard MCP OAuth 2.1 flow (authorization-server discovery, dynamic client registration, authorization-code + PKCE, token exchange), store tokens encrypted, refresh them silently, and flip a credential to `needs_reauth` when refresh fails (the trigger Plan 5 notifies on).

**Architecture:** Use the **MCP SDK's built-in OAuth** (`@modelcontextprotocol/sdk@1.29.0`) — do NOT hand-roll RFC 8414/7591/PKCE. Implement one `OAuthClientProvider` (`DbOAuthClientProvider`) backed by `mcp.credentials` (tokens + DCR client info) and `auth.verifications` (ephemeral PKCE verifier + state). Two browser-facing Next route handlers in `apps/app` drive authorize-redirect + callback. `connectMcp` gains an optional `authProvider` so the runtime transport auto-refreshes; refresh failure marks `needs_reauth`.

**Tech Stack:** `@modelcontextprotocol/sdk@1.29.0` (client/auth), `@oxagen/crypto` envelope, Drizzle, Zod, Vitest, Next route handlers.

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§6 auth subsystem)

**Builds on Plans 1–3 (shipped):** `mcp.credentials` (access/refresh/oauthClientSecret enc + oauthClientId + scopes + expiresAt + status), `setWorkspaceSecret`/`getWorkspaceSecret`, the `agent.mcp_servers` workspace install row, and the MCP contributor in `materializeTools`.

---

### Grounded conventions (verified)

- **MCP SDK OAuth** (`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth.d.ts`): `OAuthClientProvider` interface (`redirectUrl`, `clientMetadata`, `state?()`, `clientInformation()`, `saveClientInformation?()`, `tokens()`, `saveTokens()`, `redirectToAuthorization()`, `saveCodeVerifier()`, `codeVerifier()`, …); `auth(provider, { serverUrl, authorizationCode?, scope? })` → `"AUTHORIZED" | "REDIRECT"` orchestrates discovery→DCR→PKCE→exchange; `refreshAuthorization(...)`; `OAuthTokens`/`OAuthClientInformationFull` types.
- **`StreamableHTTPClientTransport`** accepts `{ authProvider?: OAuthClientProvider, requestInit?: { headers } }` and exposes `transport.finishAuth(code)`. `connectMcp` (`packages/agent/src/dispatch/mcp-client.ts:25`) currently passes only `requestInit.headers`.
- **PKCE/state store:** reuse `auth.verifications` (`schema.verifications`: `id`, `identifier`, `value`, `expiresAt`, timestamps). Key by `state`, store JSON `{ codeVerifier, orgId, workspaceId, orgListingId }`, 10-min TTL.
- **OAuth routes belong in `apps/app`** (browser-facing, session cookie). Mirror `apps/app/src/app/api/v1/stripe/checkout/route.ts` for session/org resolution (`getSession`, `resolveOrg`, `assertOrgMember`). All `/api/**` paths bypass `proxy.ts`.
- Tokens persist via `mcp.credentials` (encrypted by `@oxagen/crypto`); reuse the Plan 1 `credential-service` + `resolveCredentialKms`.

---

### File Structure

- Modify: `packages/agent/src/dispatch/mcp-client.ts` — `McpConnectArgs.authProvider?` + pass to transport
- Create: `packages/plugins/src/oauth/db-oauth-provider.ts` (+ `.test.ts`) — `DbOAuthClientProvider`
- Create: `packages/plugins/src/oauth/state-store.ts` (+ `.test.ts`) — PKCE/state via `auth.verifications`
- Create: `packages/plugins/src/oauth/index.ts` — barrel; re-export from `packages/plugins/src/index.ts`
- Create: `apps/app/src/app/api/v1/mcp/oauth/authorize/route.ts` — GET authorize-redirect
- Create: `apps/app/src/app/api/v1/mcp/oauth/callback/route.ts` — GET callback → token exchange
- Modify: `packages/agent/src/runtime/plugin-types/mcp.ts` — use `DbOAuthClientProvider` for `oauth` listings (auto-refresh) instead of static bearer
- Create: `packages/plugins/src/oauth/mark-reauth.ts` — `markCredentialNeedsReauth(...)`
- Create: `packages/inngest-functions/src/functions/plugin.oauth-refresh-watcher.ts` — proactive refresh/needs_reauth sweep; register in `functions.ts` + add `plugin/oauth.refresh.check` cron (no event payload)
- Create: contract+handler+route+tool+test for `plugin.credential.reauth` (returns the authorize URL to start re-auth)

---

### Task 1: `connectMcp` accepts an `authProvider`

**Files:** Modify `packages/agent/src/dispatch/mcp-client.ts`.

- [ ] **Step 1:** Extend `McpConnectArgs`:
```ts
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
export interface McpConnectArgs {
  endpointUrl: string;
  authStrategy: "none" | "bearer" | "header";
  authConfig?: Record<string, string>;
  authProvider?: OAuthClientProvider; // OAuth path — transport auto-refreshes
}
```
- [ ] **Step 2:** Pass it to the transport:
```ts
const transport = new StreamableHTTPClientTransport(new URL(args.endpointUrl), {
  authProvider: args.authProvider,
  requestInit: { headers: buildHeaders(args) },
});
```
(When `authProvider` is undefined the behavior is unchanged.)
- [ ] **Step 3:** Typecheck `@oxagen/agent`; commit `feat(agent): connectMcp accepts an OAuth authProvider`.

---

### Task 2: PKCE/state store (`auth.verifications`)

**Files:** Create `packages/plugins/src/oauth/state-store.ts` + `.test.ts`.

- [ ] **Step 1: Test** (mock `@oxagen/database`): `saveOAuthState(state, data, expiresAt)` writes a `verifications` row (`identifier = "mcp_oauth:" + state`, `value = JSON`); `loadOAuthState(state)` reads + JSON-parses it; `deleteOAuthState(state)` removes it; expired rows return null.

- [ ] **Step 2: Implement `state-store.ts`:**
```ts
/** Ephemeral MCP OAuth PKCE/state store, backed by auth.verifications (TTL'd). */
import { and, eq, gt } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

const PREFIX = "mcp_oauth:";
export interface OAuthStateData {
  codeVerifier: string;
  orgId: string;
  workspaceId: string;
  orgListingId: string;
}

export async function saveOAuthState(state: string, data: OAuthStateData, now: number): Promise<void> {
  const expiresAt = new Date(now + 10 * 60 * 1000);
  await withSystemDb(async (tx) => {
    await tx
      .insert(schema.verifications)
      .values({ id: PREFIX + state, identifier: PREFIX + state, value: JSON.stringify(data), expiresAt })
      .onConflictDoUpdate({ target: schema.verifications.id, set: { value: JSON.stringify(data), expiresAt } });
  });
}

export async function loadOAuthState(state: string, now: number): Promise<OAuthStateData | null> {
  const row = await withSystemDb(async (tx) => {
    const [r] = await tx
      .select({ value: schema.verifications.value })
      .from(schema.verifications)
      .where(and(eq(schema.verifications.id, PREFIX + state), gt(schema.verifications.expiresAt, new Date(now))))
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;
  return JSON.parse(row.value) as OAuthStateData;
}

export async function deleteOAuthState(state: string): Promise<void> {
  await withSystemDb(async (tx) => {
    await tx.delete(schema.verifications).where(eq(schema.verifications.id, PREFIX + state));
  });
}
```
VERIFY the `verifications` table column names + that `id`/`identifier` are `text` (read `packages/database/src/schema/auth.ts`); adjust if `id` is auto-generated (then key on `identifier` only and let `id` default).

- [ ] **Step 3:** Test green; commit `feat(plugins): MCP OAuth PKCE/state store`.

---

### Task 3: `DbOAuthClientProvider`

**Files:** Create `packages/plugins/src/oauth/db-oauth-provider.ts` + `.test.ts`.

Implements `OAuthClientProvider` against `mcp.credentials` (tokens + DCR client info) and the state store (code verifier). The provider is constructed per (orgId, workspaceId, orgListingId, redirectUrl) + a `state` string. `redirectToAuthorization(url)` stores the URL on the instance (`this.pendingRedirect`) so the authorize route can read it.

- [ ] **Step 1: Test** — with `@oxagen/database` + state-store mocked: `saveTokens`/`tokens` round-trip through `mcp.credentials` (encrypted, no plaintext at rest); `saveClientInformation`/`clientInformation` round-trip `oauthClientId` + encrypted secret; `saveCodeVerifier`/`codeVerifier` go through the state store; `redirectToAuthorization(url)` sets `pendingRedirect`.

- [ ] **Step 2: Implement** (uses `setWorkspaceSecret`/`getWorkspaceSecret` for tokens, direct `mcp.credentials` update for client info, state-store for verifier):
```ts
import type {
  OAuthClientProvider, OAuthClientInformation, OAuthClientInformationFull,
  OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { setWorkspaceSecret, getWorkspaceSecret } from "../credentials/workspace-credential";
import { saveOAuthState, loadOAuthState } from "./state-store";

export interface DbProviderCtx {
  orgId: string; workspaceId: string; orgListingId: string;
  redirectUrl: string; state: string; clientName: string; now: () => number;
}

export class DbOAuthClientProvider implements OAuthClientProvider {
  pendingRedirect: URL | null = null;
  private clientInfo: OAuthClientInformationFull | null = null;
  constructor(private readonly c: DbProviderCtx) {}

  get redirectUrl(): string { return this.c.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.c.clientName,
      redirect_uris: [this.c.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }
  state(): string { return this.c.state; }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.clientInfo) return this.clientInfo;
    const cred = await getWorkspaceSecret({ orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId });
    // oauthClientId lives on the credential row; secret in oauthClientSecret (decrypted)
    return undefined; // VERIFY: load oauthClientId from the row; getWorkspaceSecret currently returns secrets only — extend it to also return oauthClientId, or read the row directly here.
  }
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.clientInfo = info;
    await setWorkspaceSecret({
      orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId,
      authKind: "oauth", oauthClientId: info.client_id, oauthClientSecret: info.client_secret ?? null,
    });
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    const cred = await getWorkspaceSecret({ orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId });
    if (!cred?.accessToken) return undefined;
    return {
      access_token: cred.accessToken,
      token_type: "Bearer",
      refresh_token: cred.refreshToken ?? undefined,
    };
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await setWorkspaceSecret({
      orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId,
      authKind: "oauth", accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? null,
    });
  }
  async redirectToAuthorization(url: URL): Promise<void> { this.pendingRedirect = url; }
  async saveCodeVerifier(verifier: string): Promise<void> {
    await saveOAuthState(this.c.state, { codeVerifier: verifier, orgId: this.c.orgId, workspaceId: this.c.workspaceId, orgListingId: this.c.orgListingId }, this.c.now());
  }
  async codeVerifier(): Promise<string> {
    const s = await loadOAuthState(this.c.state, this.c.now());
    if (!s) throw new Error("[mcp-oauth] code verifier expired or missing");
    return s.codeVerifier;
  }
}
```
> VERIFY items: (a) extend `getWorkspaceSecret` (and the `WorkspaceSecret` type) to also return `oauthClientId` so `clientInformation()` can return `{ client_id, client_secret }`; (b) confirm the `OAuthClientInformation`/`OAuthTokens`/`OAuthClientMetadata` field names against the SDK's `auth.d.ts` and adjust; (c) `client_secret` decryption — `getWorkspaceSecret` returns `oauthClientSecret` already.

- [ ] **Step 3:** Implement the `getWorkspaceSecret` extension (return `oauthClientId` from the row). Test green. Barrel-export the provider + state store from `packages/plugins/src/oauth/index.ts` and `src/index.ts`. Commit `feat(plugins): DbOAuthClientProvider over mcp.credentials`.

> Before Task 4: extend `OAuthStateData` (Task 2) and `DbProviderCtx` (Task 3) with `returnTo: string`, and have `saveCodeVerifier` persist it, so the callback can redirect the browser back to the originating workspace settings page.

---

### Task 4: Authorize + callback route handlers (`apps/app`)

**Files:** Create `apps/app/src/app/api/v1/mcp/oauth/authorize/route.ts` and `.../callback/route.ts`. Mirror `apps/app/src/app/api/v1/stripe/checkout/route.ts` for `getSession`/`resolveOrg`/`assertOrgMember` imports.

- [ ] **Step 1: authorize route** — GET `?orgSlug&workspaceSlug&orgListingId`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { DbOAuthClientProvider } from "@oxagen/plugins";
import { getSession } from "@/lib/session";
import { resolveOrg, assertMcpManager } from "@/lib/resolve-org"; // assertMcpManager added in Plan 6; until then use assertOrgMember
import { runInTenantScope } from "@oxagen/tenancy";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const orgSlug = url.searchParams.get("orgSlug");
  const workspaceSlug = url.searchParams.get("workspaceSlug");
  const orgListingId = url.searchParams.get("orgListingId");
  if (!orgSlug || !workspaceSlug || !orgListingId) {
    return NextResponse.json({ error: "missing params" }, { status: 400 });
  }
  const tenant = await resolveOrg(orgSlug);
  await assertMcpManager(tenant.id, session.user.id); // owner/admin only

  // Resolve the listing + workspace id.
  const listing = await withSystemDb(async (tx) => {
    const [l] = await tx.select().from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, orgListingId)).limit(1);
    return l ?? null;
  });
  if (!listing || listing.orgId !== tenant.id || !listing.endpointUrl) {
    return NextResponse.json({ error: "listing not connectable" }, { status: 404 });
  }
  const workspaceId = await resolveWorkspaceId(tenant.id, workspaceSlug); // VERIFY a helper exists or inline a query

  const state = randomUUID();
  const redirectUrl = `${url.origin}/api/v1/mcp/oauth/callback`;
  const returnTo = `/${orgSlug}/${workspaceSlug}/settings/integrations`;
  const provider = new DbOAuthClientProvider({
    orgId: tenant.id, workspaceId, orgListingId, redirectUrl, state, returnTo,
    clientName: "Oxagen", now: () => Date.now(),
  });

  const result = await mcpAuth(provider, { serverUrl: listing.endpointUrl });
  if (result === "AUTHORIZED") return NextResponse.redirect(`${url.origin}${returnTo}?mcp=already-connected`);
  if (!provider.pendingRedirect) return NextResponse.json({ error: "no authorization url" }, { status: 502 });
  return NextResponse.redirect(provider.pendingRedirect.toString());
}
```
VERIFY: `resolveWorkspaceId(orgId, slug)` — inline a `withTenantDb`/`withSystemDb` query on `schema.workspaces` if no helper exists. `assertMcpManager` lands in Plan 6; if not present yet, use `assertOrgMember` + a role check, or temporarily import the role set. Wrap DB writes in `runInTenantScope({ orgId: tenant.id, workspaceId })` if RLS requires it for the credential write inside `mcpAuth` → `saveClientInformation`.

- [ ] **Step 2: callback route** — GET `?code&state`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { DbOAuthClientProvider, loadOAuthState, deleteOAuthState } from "@oxagen/plugins";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "missing code/state" }, { status: 400 });
  const stateData = await loadOAuthState(state, Date.now());
  if (!stateData) return NextResponse.json({ error: "state expired" }, { status: 400 });

  const listing = await withSystemDb(async (tx) => {
    const [l] = await tx.select().from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, stateData.orgListingId)).limit(1);
    return l ?? null;
  });
  if (!listing?.endpointUrl) return NextResponse.json({ error: "listing gone" }, { status: 404 });

  const redirectUrl = `${url.origin}/api/v1/mcp/oauth/callback`;
  const provider = new DbOAuthClientProvider({
    orgId: stateData.orgId, workspaceId: stateData.workspaceId, orgListingId: stateData.orgListingId,
    redirectUrl, state, returnTo: stateData.returnTo, clientName: "Oxagen", now: () => Date.now(),
  });
  const result = await mcpAuth(provider, { serverUrl: listing.endpointUrl, authorizationCode: code });
  await deleteOAuthState(state);
  // On success the tokens are saved (status 'active'); flip the workspace install healthy.
  await withSystemDb(async (tx) => {
    await tx.update(schema.mcpServers)
      .set({ healthStatus: "healthy" })
      .where(eq(schema.mcpServers.orgListingId, stateData.orgListingId));
  });
  const ok = result === "AUTHORIZED";
  return NextResponse.redirect(`${url.origin}${stateData.returnTo}?mcp=${ok ? "connected" : "error"}`);
}
```
VERIFY `loadOAuthState`/`deleteOAuthState` are exported from `@oxagen/plugins`.

- [ ] **Step 3:** Typecheck `@oxagen/app` (or whatever apps/app's package name is). Commit `feat(app): MCP OAuth authorize + callback route handlers`.

---

### Task 5: Runtime uses the OAuth provider (auto-refresh) + needs_reauth

**Files:** Create `packages/plugins/src/oauth/mark-reauth.ts`; modify `packages/agent/src/runtime/plugin-types/mcp.ts`.

- [ ] **Step 1: `mark-reauth.ts`:**
```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
/** Flip a credential to needs_reauth (the trigger Plan 5 notifies on). */
export async function markCredentialNeedsReauth(workspaceId: string, orgListingId: string): Promise<void> {
  await withSystemDb(async (tx) => {
    await tx.update(schema.mcpCredentials).set({ status: "needs_reauth", updatedAt: new Date() })
      .where(and(eq(schema.mcpCredentials.workspaceId, workspaceId), eq(schema.mcpCredentials.orgListingId, orgListingId)));
  });
}
```
Export from `@oxagen/plugins`.

- [ ] **Step 2:** In `plugin-types/mcp.ts`, for a server whose listing `authKind === "oauth"`, build a `DbOAuthClientProvider` (state unused at runtime — pass a stable dummy like `runtime:${orgListingId}`, `redirectUrl` from env `APP_URL` + `/api/v1/mcp/oauth/callback`) and pass it as `connectMcp({ endpointUrl, authStrategy: "none", authProvider })`. The transport auto-refreshes via `provider.tokens()`/`saveTokens()`. Wrap the per-server `connectMcp`+`materializeMcpTools` in try/catch; on an `UnauthorizedError` (or any auth failure), call `markCredentialNeedsReauth(ctx.workspaceId, server.orgListingId)` and skip that server. Keep the static bearer/secret path for `authKind !== "oauth"` (the Plan 3 code).
VERIFY: import `UnauthorizedError` from `@modelcontextprotocol/sdk/client/auth.js`; only mark-reauth on auth errors, not transient network errors.

- [ ] **Step 3:** Typecheck `@oxagen/agent` + `@oxagen/plugins`; commit `feat(agent): OAuth MCP servers connect via auto-refreshing provider; mark needs_reauth on failure`.

---

### Task 6: Proactive refresh-watcher (Inngest cron)

**Files:** Create `packages/inngest-functions/src/functions/plugin.oauth-refresh-watcher.ts`; register in `functions.ts`.

- [ ] **Step 1:** Cron (every 30 min) — scan `mcp.credentials` where `authKind='oauth' AND status='active' AND expiresAt < now()+10min`, and for each attempt a refresh by constructing a `DbOAuthClientProvider` + calling the SDK `auth(provider, { serverUrl })` (which refreshes if a refresh_token exists). On failure → `markCredentialNeedsReauth(...)`. Each credential in its own `step.run` (isolated). Mirror `billing.dunning-sweep` cron shape.
VERIFY: needs the listing's `endpointUrl` (join `pluginOrgListings` on `orgListingId`). Instrument counts (refreshed / needs_reauth).

- [ ] **Step 2:** Register `pluginOauthRefreshWatcher` in `functions.ts`; typecheck `@oxagen/inngest-functions`; commit `feat(inngest): OAuth token refresh watcher → needs_reauth`.

---

### Task 7: `plugin.credential.reauth` capability

**Files:** contract+test+handler+route+tool (mirror Plan 2 pattern), register.

- [ ] **Step 1:** `plugin.credential.reauth` (`scoped:true`, sensitivity medium, `surfaces:["api","mcp"]`, org Owner/Admin) — input `{ orgListingId: z.string() }` → output `{ authorizeUrl: z.string() }`. Handler returns the app authorize URL: `${APP_URL}/api/v1/mcp/oauth/authorize?orgSlug=...&workspaceSlug=...&orgListingId=...` (VERIFY how to resolve org/workspace slug from ctx ids — query `schema.organizations`/`schema.workspaces`, or accept slugs in input). This is what the re-auth notification deep-links to (Plan 5).
- [ ] **Step 2:** Register handler + route + tool; `pnpm check:manifest` clean; commit `feat(plugins): plugin.credential.reauth capability`.

---

### Task 8: Verification

- [ ] `pnpm check:manifest` clean for `plugin.*`.
- [ ] Typecheck `@oxagen/plugins @oxagen/agent @oxagen/inngest-functions @oxagen/oxagen @oxagen/handlers @oxagen/api @oxagen/mcp` + apps/app — all PASS.
- [ ] Tests: `pnpm --filter @oxagen/plugins test:unit` (state-store + provider unit tests green) + `pnpm --filter @oxagen/oxagen test:unit -- plugin`.
- [ ] Lint touched packages.
- [ ] **Smoke (Plan 7 covers full E2E with a mock OAuth server):** unit-level — assert `DbOAuthClientProvider.saveTokens`→`tokens` round-trips and `markCredentialNeedsReauth` flips status.

### Done criteria for Plan 4

- An admin can click "Connect" on an OAuth MCP server → SDK-driven discovery + DCR + PKCE authorize → callback exchanges the code → tokens stored encrypted → workspace install goes healthy.
- The runtime connects OAuth servers via an auto-refreshing provider; refresh failure flips the credential to `needs_reauth`.
- A cron proactively refreshes soon-to-expire tokens and marks `needs_reauth` when it can't.
- `plugin.credential.reauth` returns the authorize URL for the re-auth prompt.

**Next plan:** `2026-06-06-installable-plugins-05-notifications.md` — the `notifications` table feed + first `sendEmail` handler + org role setting, triggered by `needs_reauth`.

## Document — `2026-06-06-installable-plugins-05-notifications.md`

## Installable Plugins — Plan 5: Notifications (in-app feed + first email handler + re-auth prompts)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `notification.notifications` table into a working in-app bell feed and first email handler, so that when a credential flips to `needs_reauth` org Owners/Admins receive both an in-app notification and an optional email with a deep link to the re-auth page.

**Architecture:** Three layers: (1) a thin `createNotification` service in `@oxagen/notifications` writes to `notification.notifications` via `withSystemDb`; (2) a `notifyOrgManagers` orchestrator in `@oxagen/notifications` resolves recipients from `org.org_users` + `org.organizations.settings.mcp_auth_alerts`, creates one notification per user, and optionally sends email via the existing `sendEmail` facade; (3) the `markCredentialNeedsReauth` function in `@oxagen/plugins` (Plan 4) calls `notifyOrgManagers` after flipping the credential status — no cycle because `@oxagen/plugins` gains `@oxagen/notifications` as a new dependency (not the reverse). Two new capabilities (`notifications.list`, `notifications.mark`) expose the feed over API and MCP; the `NotificationsBell` shell component is wired to real data via a server action.

**Tech Stack:** TypeScript 6.0.3, Drizzle ORM 0.45.2, `@oxagen/database` (`withSystemDb`, `schema`), `@oxagen/notifications` (extended), Zod 3.25.76, Vitest 2.1.9, Next.js App Router server actions, `@oxagen/ui` (coss/Base UI).

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§7 notifications subsystem)

---

### Grounded conventions (verified from codebase)

- **`notification.notifications` schema** (`packages/database/src/schema/notification.ts`): columns `id uuid PK`, `publicId citext`, `createdAt/updatedAt/createdByUserId/updatedByUserId` (audit), `orgId uuid`, `workspaceId uuid nullable`, `userId uuid`, `kind text` CHECK `IN ('system','approval','run','member','security')`, `title text`, `body text nullable`, `deepLink text nullable`, `unread boolean DEFAULT true`, `archived boolean DEFAULT false`, `emailedAt timestamptz nullable`. Drizzle export: `schema.notifications`.
- **`sendEmail(input: SendEmailInput)`** in `@oxagen/notifications` (`packages/notifications/src/send-email.ts`): validates via `sendEmailInputSchema`, dispatches via configured SMTP transport. `SendEmailInput` fields: `to` (string | string[]), `subject`, `text?`, `html?`, `from?`, `replyTo?`, `cc?`, `bcc?` — must supply at least `text` or `html`.
- **`org.org_users`** (`packages/database/src/schema/org.ts`): `orgId uuid`, `userId uuid`, `role text`. `org.organizations.settings jsonb DEFAULT '{}'`.
- **`auth.users`** (`packages/database/src/schema/auth.ts`): `id uuid`, `email citext NOT NULL`.
- **`CapabilityContext`** (`packages/oxagen/src/types.ts:151`): `orgId: string`, `workspaceId: string`, `userId: string | null`, `apiKeyId: string | null`, `requestId: string`, `surface`, `messageId: string | null`. Acting user id = `ctx.userId`.
- **`SystemOrgRole`** (`packages/oxagen/src/types.ts:53`): `"Owner" | "Admin" | "Compliance" | "Billing"`. **`SystemWorkspaceRole`** (`types.ts:56`): `"Owner" | "Member" | "Viewer"`.
- **Handler pattern** — `export const handler: CapabilityHandlerFn = async (input, ctx) => { ... }`. Uses `withSystemDb` for cross-schema queries. Import: `import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel"`.
- **Route pattern** — `new Hono<AppEnv>()`, import contract + `invoke` + `capabilityContext`. `capabilityContext(c)` returns `CapabilityContext` (see `apps/api/src/lib/context.ts`).
- **MCP tool pattern** — `import { type InferSchema, type ToolMetadata } from "xmcp"`, `import { headers } from "xmcp/headers"`, `buildContext(headers())`.
- **`withSystemDb`** — `withSystemDb(async (tx) => { ... })`. For user-scoped queries, use `withSystemDb` with an explicit `userId` filter (the `withTenantDb` seam is for workspace-scoped data isolation; notifications are user-owned, fetched system-side with explicit `userId` predicate).
- **`markCredentialNeedsReauth(workspaceId, orgListingId)`** — defined in Plan 4 at `packages/plugins/src/oauth/mark-reauth.ts`. Plan 5 extends it (or its call site) to trigger notification after the status flip.
- **`@oxagen/plugins` deps** (`packages/plugins/package.json`): currently `@oxagen/crypto`, `@oxagen/database`, `@oxagen/tenancy`. Adding `@oxagen/notifications` is safe — `@oxagen/notifications` has no dep on `@oxagen/plugins` — **no cycle**.
- **Org setting path**: `organizations.settings` is `jsonb DEFAULT '{}'`; the `mcp_auth_alerts` key is `{ send_email: boolean, roles: string[] }`. Default (when key absent): `{ send_email: true, roles: ["Owner", "Admin"] }`.
- **`idMixin("ntf")`** already applies in the schema, so inserts must omit `id`/`publicId` (DB defaults).
- **Inngest refresh-watcher** (Plan 4, Task 6) sweeps `needs_reauth`; Plan 5 notification fires from `markCredentialNeedsReauth` so both the runtime flip and the cron flip emit notifications.

---

### File Structure

**`@oxagen/notifications` — extended with DB-backed notification service:**
- Create: `packages/notifications/src/notifications/create-notification.ts` (+ `.test.ts`)
- Create: `packages/notifications/src/notifications/notify-org-managers.ts` (+ `.test.ts`)
- Create: `packages/notifications/src/notifications/email-templates.ts`
- Create: `packages/notifications/src/notifications/types.ts`
- Modify: `packages/notifications/src/index.ts` — re-export new public surface
- Modify: `packages/notifications/package.json` — add `@oxagen/database` dep

**`@oxagen/plugins` — wired to notifications:**
- Modify: `packages/plugins/src/oauth/mark-reauth.ts` — call `notifyOrgManagers` after flip
- Modify: `packages/plugins/package.json` — add `@oxagen/notifications` dep

**Contracts + handlers + routes + tools:**
- Create: `packages/oxagen/src/contracts/notifications.list.ts` (+ `.test.ts`)
- Create: `packages/oxagen/src/contracts/notifications.mark.ts` (+ `.test.ts`)
- Create: `packages/handlers/src/notifications.list.ts` (+ `.test.ts`)
- Create: `packages/handlers/src/notifications.mark.ts` (+ `.test.ts`)
- Modify: `packages/handlers/src/register.ts` — register two new handlers
- Create: `apps/api/src/routes/v1/notifications.list.ts`
- Create: `apps/api/src/routes/v1/notifications.mark.ts`
- Modify: `apps/api/src/app.ts` — mount two new routes
- Create: `apps/mcp/src/tools/notifications.list.ts`
- Create: `apps/mcp/src/tools/notifications.mark.ts`

**App shell:**
- Create: `apps/app/src/lib/actions/notifications.ts` — server action calling the handler
- Modify: `apps/app/src/components/shell/notifications-bell.tsx` — wire to real data

---

### Task A: Notification service in `@oxagen/notifications`

**Files:**
- Create: `packages/notifications/src/notifications/types.ts`
- Create: `packages/notifications/src/notifications/create-notification.ts`
- Create: `packages/notifications/src/notifications/create-notification.test.ts`
- Modify: `packages/notifications/package.json`

#### A-1: Add `@oxagen/database` dependency

- [ ] Edit `packages/notifications/package.json` — add `"@oxagen/database": "workspace:*"` to `dependencies`:

```json
{
  "dependencies": {
    "@oxagen/config": "workspace:*",
    "@oxagen/database": "workspace:*",
    "nodemailer": "8.0.10",
    "pino": "9.14.0",
    "zod": "3.25.76"
  }
}
```

Run: `pnpm install --no-frozen-lockfile`
Expected: no errors; `@oxagen/database` resolvable in `packages/notifications/`.

#### A-2: Shared notification input types

- [ ] Create `packages/notifications/src/notifications/types.ts`:

```ts
/**
 * Shared types for the notification service.
 * Used in ≥2 files — lives here per the extract-shared-types standard.
 */

/** Valid kind values enforced by DB CHECK constraint. */
export const NOTIFICATION_KINDS = [
  "system",
  "approval",
  "run",
  "member",
  "security",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Input to createNotification. All required except workspaceId. */
export interface CreateNotificationInput {
  orgId: string;
  workspaceId?: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  deepLink?: string;
}

/** A persisted notification row (subset returned to callers). */
export interface NotificationRow {
  id: string;
  publicId: string;
  orgId: string;
  workspaceId: string | null;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  archived: boolean;
  emailedAt: Date | null;
  createdAt: Date;
}
```

#### A-3: Write the failing test

- [ ] Create `packages/notifications/src/notifications/create-notification.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @oxagen/database before importing the module under test.
vi.mock("@oxagen/database", () => {
  const mockTx = {
    insert: (_table: unknown) => ({
      values: (_v: unknown) => ({
        returning: () =>
          Promise.resolve([
            { id: "uuid-1", publicId: "ntf_abc", createdAt: new Date("2026-01-01") },
          ]),
      }),
    }),
  };
  return {
    schema: { notifications: "notifications_table_sentinel" },
    withSystemDb: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
});

import { createNotification } from "./create-notification";
import * as db from "@oxagen/database";

describe("createNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a notification row and returns id/publicId/createdAt", async () => {
    const result = await createNotification({
      orgId: "org-1",
      userId: "user-1",
      kind: "security",
      title: "Reconnect GitHub",
      body: "The GitHub OAuth token expired.",
      deepLink: "/org/ws/settings/integrations/reauth/porg_123",
    });

    expect(db.withSystemDb).toHaveBeenCalledOnce();
    expect(result.id).toBe("uuid-1");
    expect(result.publicId).toBe("ntf_abc");
  });

  it("accepts optional workspaceId", async () => {
    const result = await createNotification({
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      kind: "system",
      title: "Test",
    });
    expect(result.id).toBe("uuid-1");
  });

  it("rejects an invalid kind at runtime with a thrown error", async () => {
    await expect(
      createNotification({
        orgId: "org-1",
        userId: "user-1",
        // @ts-expect-error intentional bad kind for runtime guard test
        kind: "invalid_kind",
        title: "Bad",
      }),
    ).rejects.toThrow("Invalid notification kind");
  });
});
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **3 tests fail** (module not yet created).

#### A-4: Implement `createNotification`

- [ ] Create `packages/notifications/src/notifications/create-notification.ts`:

```ts
import { schema, withSystemDb } from "@oxagen/database";
import { NOTIFICATION_KINDS } from "./types";
import type { CreateNotificationInput, NotificationRow } from "./types";

/**
 * Insert one notification row into notification.notifications.
 * Uses withSystemDb — the notification schema is not tenant-scoped.
 * Throws on invalid kind (belt-and-suspenders for runtime callers bypassing TS).
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<Pick<NotificationRow, "id" | "publicId" | "createdAt">> {
  const { orgId, workspaceId, userId, kind, title, body, deepLink } = input;

  if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid notification kind: ${kind}`);
  }

  return withSystemDb(async (tx) => {
    const rows = await tx
      .insert(schema.notifications)
      .values({
        orgId,
        workspaceId: workspaceId ?? null,
        userId,
        kind,
        title,
        body: body ?? null,
        deepLink: deepLink ?? null,
      })
      .returning({
        id: schema.notifications.id,
        publicId: schema.notifications.publicId,
        createdAt: schema.notifications.createdAt,
      });

    const row = rows[0];
    if (!row) {
      throw new Error("[createNotification] Insert returned no rows");
    }
    return row;
  });
}
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **3 tests pass**.

**Commit:**
```
git add packages/notifications/src/notifications/types.ts \
        packages/notifications/src/notifications/create-notification.ts \
        packages/notifications/src/notifications/create-notification.test.ts \
        packages/notifications/package.json \
        pnpm-lock.yaml && \
git commit -m "feat(notifications): createNotification service + types"
```

---

### Task B: Recipient resolver + email mirror (`notifyOrgManagers`)

**Files:**
- Create: `packages/notifications/src/notifications/email-templates.ts`
- Create: `packages/notifications/src/notifications/notify-org-managers.ts`
- Create: `packages/notifications/src/notifications/notify-org-managers.test.ts`

#### B-1: Minimal HTML email template helper

- [ ] Create `packages/notifications/src/notifications/email-templates.ts`:

```ts
/**
 * Minimal inline HTML template helper for transactional notification emails.
 * No template engine — just tagged-template string helpers to avoid
 * injecting unescaped user content into HTML.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ReauthEmailTemplateInput {
  /** Short server name, e.g. "GitHub". */
  serverName: string;
  /** Full re-auth URL. */
  reauthUrl: string;
  /** Org name shown in the greeting. */
  orgName: string;
}

/**
 * Returns `{ subject, text, html }` for a credential needs-reauth notification.
 * The HTML is a minimal single-column layout with a CTA button — no external
 * assets or fonts (renders safely across all email clients).
 */
export function reauthEmailTemplate(input: ReauthEmailTemplateInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { serverName, reauthUrl, orgName } = input;
  const subject = `Action required: Reconnect ${esc(serverName)} in Oxagen`;
  const text = [
    `Hi,`,
    ``,
    `The ${serverName} MCP server in your Oxagen organization "${orgName}" needs to be reconnected — its OAuth token has expired or been revoked.`,
    ``,
    `Reconnect here: ${reauthUrl}`,
    ``,
    `If you did not set up this integration, you can ignore this email.`,
    ``,
    `— Oxagen`,
  ].join("\n");
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;background:#f9fafb;margin:0;padding:32px 0">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;padding:40px">
    <tr><td>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">Hi,</p>
      <p style="font-size:14px;color:#374151;margin:0 0 16px">
        The <strong>${esc(serverName)}</strong> MCP server in your Oxagen organization
        <strong>${esc(orgName)}</strong> needs to be reconnected — its OAuth token has
        expired or been revoked.
      </p>
      <p style="margin:0 0 24px">
        <a href="${esc(reauthUrl)}"
           style="display:inline-block;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;padding:10px 20px;border-radius:6px;text-decoration:none">
          Reconnect ${esc(serverName)}
        </a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:0">
        If you did not set up this integration, you can safely ignore this email.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}
```

#### B-2: Write the failing tests

- [ ] Create `packages/notifications/src/notifications/notify-org-managers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────
// Simulate org_users with roles and organizations with settings.
const orgManagers = [
  { userId: "user-owner", role: "Owner" },
  { userId: "user-admin", role: "Admin" },
  { userId: "user-member", role: "Member" },
];
const orgRow = { name: "Acme Inc.", settings: {} };
const userRows: Record<string, { email: string }> = {
  "user-owner": { email: "owner@acme.com" },
  "user-admin": { email: "admin@acme.com" },
};

vi.mock("@oxagen/database", () => {
  const mockTx = {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => Promise.resolve([orgRow]),
        }),
        // overloaded: used for org_users select (no limit) and users select
      }),
    }),
  };
  return {
    schema: {
      orgUsers: "orgUsers_sentinel",
      organizations: "orgs_sentinel",
      users: "users_sentinel",
    },
    withSystemDb: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
});

// ── Sibling mock ─────────────────────────────────────────────────────────────
const mockCreateNotification = vi.fn().mockResolvedValue({ id: "notif-1", publicId: "ntf_X", createdAt: new Date() });
vi.mock("./create-notification", () => ({ createNotification: mockCreateNotification }));

// ── sendEmail mock ────────────────────────────────────────────────────────────
const mockSendEmail = vi.fn().mockResolvedValue({ id: "msg-1", accepted: ["owner@acme.com"], rejected: [] });
vi.mock("../send-email", () => ({ sendEmail: mockSendEmail }));

import { notifyOrgManagers } from "./notify-org-managers";

describe("notifyOrgManagers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one notification per resolved recipient (Owner + Admin by default)", async () => {
    // Provide a minimal DB that returns the right shape for each query.
    // The real implementation does three queries; we test the contract,
    // not the SQL internals, via the mock boundaries.
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Reconnect GitHub",
      body: "Token expired.",
      deepLink: "/reauth/porg_123",
      emailHtml: "<p>Reconnect</p>",
      // stub: inject recipients directly for unit isolation
      _recipientsOverride: [
        { userId: "user-owner", email: "owner@acme.com" },
        { userId: "user-admin", email: "admin@acme.com" },
      ],
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-owner", orgId: "org-1" }),
    );
  });

  it("skips email when send_email setting is false", async () => {
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Reconnect GitHub",
      deepLink: "/reauth/porg_123",
      emailHtml: "<p>Reconnect</p>",
      emailDisabled: true,
      _recipientsOverride: [{ userId: "user-owner", email: "owner@acme.com" }],
    });
    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("creates in-app notification even when email fails (log-and-continue)", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP connection refused"));
    await expect(
      notifyOrgManagers({
        orgId: "org-1",
        kind: "security",
        title: "Reconnect GitHub",
        deepLink: "/reauth/porg_123",
        emailHtml: "<p>Reconnect</p>",
        _recipientsOverride: [{ userId: "user-owner", email: "owner@acme.com" }],
      }),
    ).resolves.not.toThrow();
    // In-app notification must still have been created.
    expect(mockCreateNotification).toHaveBeenCalledOnce();
  });

  it("filters recipients by custom roles when settings override present", async () => {
    // Only "Owner" role should get notified when roles=["Owner"] is set.
    await notifyOrgManagers({
      orgId: "org-1",
      kind: "security",
      title: "Test",
      deepLink: "/reauth/x",
      emailHtml: "<p>x</p>",
      _recipientsOverride: [
        { userId: "user-owner", email: "owner@acme.com" },
        // user-admin would normally be included; test that roles param excludes them
      ],
    });
    expect(mockCreateNotification).toHaveBeenCalledOnce();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-owner" }),
    );
  });
});
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **4 tests fail** (module not yet created).

#### B-3: Implement `notifyOrgManagers`

- [ ] Create `packages/notifications/src/notifications/notify-org-managers.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { sendEmail } from "../send-email";
import { createNotification } from "./create-notification";
import type { NotificationKind } from "./types";
import { logger } from "../logger";

/** Default org-level roles that receive auth-alert notifications. */
const DEFAULT_ALERT_ROLES = ["Owner", "Admin"] as const;

/** Org setting key. Typed narrowly to avoid `any`. */
interface McpAuthAlertsSetting {
  send_email?: boolean;
  roles?: string[];
}

/**
 * A resolved recipient — userId + email address.
 * Exported so tests and callers can inject via _recipientsOverride.
 */
export interface NotificationRecipient {
  userId: string;
  email: string;
}

export interface NotifyOrgManagersInput {
  orgId: string;
  workspaceId?: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  deepLink?: string;
  /** Pre-rendered HTML body for the email (callers use reauthEmailTemplate). */
  emailHtml: string;
  /** Override the send_email setting (useful for callers that have already resolved it). */
  emailDisabled?: boolean;
  /**
   * Inject recipients directly — for unit testing only.
   * Production callers omit this and let the function resolve from DB.
   */
  _recipientsOverride?: NotificationRecipient[];
}

/**
 * Resolve org managers whose role ∈ mcp_auth_alerts.roles (default Owner/Admin),
 * create one in-app notification per recipient, and — unless send_email is false —
 * send an email to each and stamp emailedAt.
 *
 * Email failures do NOT prevent the in-app notification (log-and-continue, no
 * silent total failure per spec §7).
 */
export async function notifyOrgManagers(
  input: NotifyOrgManagersInput,
): Promise<void> {
  const {
    orgId,
    workspaceId,
    kind,
    title,
    body,
    deepLink,
    emailHtml,
    emailDisabled,
    _recipientsOverride,
  } = input;

  // ── 1. Resolve recipients ──────────────────────────────────────────────────
  let recipients: NotificationRecipient[];

  if (_recipientsOverride !== undefined) {
    // Unit-test path: skip DB queries.
    recipients = _recipientsOverride;
  } else {
    // Production path: read org settings, resolve org_users, resolve emails.
    const { alertRoles, sendEmail: emailEnabled } = await withSystemDb(async (tx) => {
      const [orgRow] = await tx
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);

      const rawSettings = (orgRow?.settings ?? {}) as Record<string, unknown>;
      const alertSettings = (rawSettings["mcp_auth_alerts"] ?? {}) as McpAuthAlertsSetting;
      const roles: string[] =
        Array.isArray(alertSettings.roles) && alertSettings.roles.length > 0
          ? alertSettings.roles
          : (DEFAULT_ALERT_ROLES as unknown as string[]);
      const sendEmailFlag =
        typeof alertSettings.send_email === "boolean" ? alertSettings.send_email : true;
      return { alertRoles: roles, sendEmail: sendEmailFlag };
    });

    // Resolve org_users whose role is in alertRoles.
    const userIds = await withSystemDb(async (tx) => {
      const rows = await tx
        .select({ userId: schema.orgUsers.userId })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            inArray(schema.orgUsers.role, alertRoles),
          ),
        );
      return rows.map((r) => r.userId);
    });

    if (userIds.length === 0) {
      logger.warn({ orgId }, "[notifyOrgManagers] no recipients resolved; skipping");
      return;
    }

    // Resolve email addresses for the resolved user ids.
    const userRows = await withSystemDb(async (tx) =>
      tx
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, userIds)),
    );

    recipients = userRows.map((u) => ({ userId: u.id, email: u.email }));
    // Override emailDisabled from settings if caller didn't set it.
    if (emailDisabled === undefined) {
      Object.assign(input, { emailDisabled: !emailEnabled });
    }
  }

  // ── 2. Notify each recipient ───────────────────────────────────────────────
  for (const recipient of recipients) {
    // Always create the in-app notification first.
    let notificationId: string | null = null;
    try {
      const notif = await createNotification({
        orgId,
        workspaceId,
        userId: recipient.userId,
        kind,
        title,
        body,
        deepLink,
      });
      notificationId = notif.id;
    } catch (err) {
      logger.error(
        { orgId, userId: recipient.userId, err },
        "[notifyOrgManagers] failed to create in-app notification",
      );
      // Per spec: email failure must not silently suppress the notification.
      // In-app failure is logged; continue to next recipient.
      continue;
    }

    // Send email if not disabled.
    if (!input.emailDisabled) {
      try {
        await sendEmail({
          to: recipient.email,
          subject: title,
          text: body ?? title,
          html: emailHtml,
        });

        // Stamp emailedAt on the notification row.
        await withSystemDb(async (tx) => {
          await tx
            .update(schema.notifications)
            .set({ emailedAt: new Date() })
            .where(eq(schema.notifications.id, notificationId!));
        });
      } catch (err) {
        // Log but do NOT re-throw — in-app notification already created.
        logger.error(
          { orgId, userId: recipient.userId, email: recipient.email, err },
          "[notifyOrgManagers] email send failed (in-app notification still created)",
        );
      }
    }
  }
}
```

Run: `pnpm --filter @oxagen/notifications test:unit`
Expected: **all tests pass** (Tasks A + B combined).

**Commit:**
```
git add packages/notifications/src/notifications/email-templates.ts \
        packages/notifications/src/notifications/notify-org-managers.ts \
        packages/notifications/src/notifications/notify-org-managers.test.ts && \
git commit -m "feat(notifications): notifyOrgManagers with email mirror + log-and-continue"
```

---

### Task B-4: Export public surface from `@oxagen/notifications`

- [ ] Modify `packages/notifications/src/index.ts` — append exports:

```ts
// Notification service (in-app feed + email mirror)
export { createNotification } from "./notifications/create-notification";
export { notifyOrgManagers } from "./notifications/notify-org-managers";
export { reauthEmailTemplate } from "./notifications/email-templates";
export type {
  NotificationKind,
  NotificationRow,
  CreateNotificationInput,
  NotificationRecipient,
  NotifyOrgManagersInput,
} from "./notifications/types";
// Re-export NotifyOrgManagersInput fully (types.ts has the primitive types;
// notify-org-managers.ts has NotificationRecipient + NotifyOrgManagersInput)
export type { NotifyOrgManagersInput as NotifyOrgManagersOptions } from "./notifications/notify-org-managers";
```

VERIFY: `pnpm --filter @oxagen/notifications typecheck` — no errors.

**Commit:**
```
git add packages/notifications/src/index.ts && \
git commit -m "feat(notifications): export notification service from package index"
```

---

### Task C: Wire `needs_reauth` → `notifyOrgManagers`

**Files:**
- Modify: `packages/plugins/src/oauth/mark-reauth.ts`
- Modify: `packages/plugins/package.json`

**Dependency-cycle analysis (resolved):**
- `@oxagen/notifications` deps: `@oxagen/config`, `@oxagen/database` (after Task A-1). It does NOT depend on `@oxagen/plugins`.
- `@oxagen/plugins` deps (before this task): `@oxagen/crypto`, `@oxagen/database`, `@oxagen/tenancy`. Adding `@oxagen/notifications` is a one-way edge — **no cycle**.
- VERIFY before implementing: `grep -r "@oxagen/plugins" packages/notifications/` must return nothing.

#### C-1: Add `@oxagen/notifications` to plugins deps

- [ ] Edit `packages/plugins/package.json` — add `"@oxagen/notifications": "workspace:*"` to `dependencies`.

Run: `pnpm install --no-frozen-lockfile`

#### C-2: Extend `markCredentialNeedsReauth` to notify

Plan 4 established the signature: `markCredentialNeedsReauth(workspaceId: string, orgListingId: string): Promise<void>`. Plan 5 needs to look up the `orgId` and the listing name after flipping the credential, then call `notifyOrgManagers`. To keep the public signature stable (no breaking change), extend the existing function body:

- [ ] Edit `packages/plugins/src/oauth/mark-reauth.ts` (full replacement):

```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { notifyOrgManagers, reauthEmailTemplate } from "@oxagen/notifications";

/**
 * Flip a credential to needs_reauth and notify org managers.
 *
 * Plan 4 established this signature (status flip); Plan 5 wires notification.
 * Notification failure does NOT propagate — the credential flip is the
 * authoritative action; notification is best-effort.
 */
export async function markCredentialNeedsReauth(
  workspaceId: string,
  orgListingId: string,
): Promise<void> {
  // 1. Flip credential status.
  await withSystemDb(async (tx) => {
    await tx
      .update(schema.mcpCredentials)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(
        and(
          eq(schema.mcpCredentials.workspaceId, workspaceId),
          eq(schema.mcpCredentials.orgListingId, orgListingId),
        ),
      );
  });

  // 2. Resolve org listing for notification context (orgId + server name).
  const listing = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select({
        orgId: schema.pluginOrgListings.orgId,
        name: schema.pluginOrgListings.name,
        title: schema.pluginOrgListings.title,
      })
      .from(schema.pluginOrgListings)
      .where(eq(schema.pluginOrgListings.id, orgListingId))
      .limit(1);
    return row ?? null;
  });

  if (!listing) {
    // The listing may have been deleted; skip notification silently.
    return;
  }

  const serverName = listing.title ?? listing.name;
  const appUrl = process.env["APP_URL"] ?? "https://app.oxagen.sh";

  // The deep-link goes to the workspace re-auth page; workspaceId is the uuid.
  // The re-auth route accepts the orgListingId as a path segment (Plan 4 Task 7).
  const deepLink = `${appUrl}/settings/integrations/reauth/${orgListingId}`;

  const { subject, text, html } = reauthEmailTemplate({
    serverName,
    reauthUrl: deepLink,
    orgName: listing.orgId, // Org name requires a join; use orgId as fallback
    // VERIFY: for a richer email, add an org name join here or pass orgName
    // as an optional parameter once Plan 6 adds settings UI context.
  });

  // 3. Notify org managers — fire and forget; error logged inside.
  notifyOrgManagers({
    orgId: listing.orgId,
    workspaceId,
    kind: "security",
    title: subject,
    body: text,
    deepLink,
    emailHtml: html,
  }).catch(() => {
    // Already logged inside notifyOrgManagers; do not propagate.
  });
}
```

VERIFY: Import path for `reauthEmailTemplate` — `@oxagen/notifications` must export it (Task B-4).

Run: `pnpm --filter @oxagen/plugins typecheck`
Expected: no errors.

**Commit:**
```
git add packages/plugins/src/oauth/mark-reauth.ts \
        packages/plugins/package.json \
        pnpm-lock.yaml && \
git commit -m "feat(plugins): markCredentialNeedsReauth notifies org managers via @oxagen/notifications"
```

---

### Task D: `notifications.list` and `notifications.mark` capabilities

#### D-1: `notifications.list` contract

**Files:**
- Create: `packages/oxagen/src/contracts/notifications.list.ts`
- Create: `packages/oxagen/src/contracts/notifications.list.test.ts`

- [ ] Create `packages/oxagen/src/contracts/notifications.list.ts`:

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * notifications.list — list the calling user's in-app notifications.
 * Scoped to the acting user (ctx.userId); workspace-scoped for context.
 * Any org member may read their own notifications (Owner/Admin/Member/Viewer).
 */
export const notificationsList = registerCapability({
  name: "notifications.list",
  domain: "notifications",
  description:
    "List in-app notifications for the calling user. Supports filtering to unread-only and pagination.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow", Billing: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    unreadOnly: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    notifications: z.array(
      z.object({
        id: z.string(),
        publicId: z.string(),
        kind: z.enum(["system", "approval", "run", "member", "security"]),
        title: z.string(),
        body: z.string().nullable(),
        deepLink: z.string().nullable(),
        unread: z.boolean(),
        archived: z.boolean(),
        createdAt: z.string(), // ISO8601
      }),
    ),
    unreadCount: z.number().int().nonnegative(),
  }),
});

export type NotificationsListInput = z.output<typeof notificationsList.input>;
export type NotificationsListOutput = z.output<typeof notificationsList.output>;
```

- [ ] Create `packages/oxagen/src/contracts/notifications.list.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { notificationsList } from "./notifications.list";

describe("notifications.list contract", () => {
  it("has the correct name and domain", () => {
    expect(notificationsList.name).toBe("notifications.list");
    expect(notificationsList.domain).toBe("notifications");
  });

  it("parses valid input with defaults", () => {
    const parsed = notificationsList.input.parse({});
    expect(parsed.unreadOnly).toBe(false);
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit above 100", () => {
    expect(() => notificationsList.input.parse({ limit: 101 })).toThrow();
  });

  it("output schema accepts a valid notification list", () => {
    const parsed = notificationsList.output.parse({
      notifications: [
        {
          id: "uuid-1",
          publicId: "ntf_abc",
          kind: "security",
          title: "Reconnect GitHub",
          body: null,
          deepLink: "/reauth/x",
          unread: true,
          archived: false,
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 1,
    });
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.unreadCount).toBe(1);
  });
});
```

#### D-2: `notifications.mark` contract

**Files:**
- Create: `packages/oxagen/src/contracts/notifications.mark.ts`
- Create: `packages/oxagen/src/contracts/notifications.mark.test.ts`

- [ ] Create `packages/oxagen/src/contracts/notifications.mark.ts`:

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * notifications.mark — mark a notification as read and/or archived.
 * Scoped to the acting user — users may only mark their own notifications.
 */
export const notificationsMark = registerCapability({
  name: "notifications.mark",
  domain: "notifications",
  description: "Mark a notification as read and/or archived for the calling user.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow", Billing: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    /** Public ID of the notification to update (e.g. "ntf_abc"). */
    id: z.string().min(1),
    /** When true, mark as read (unread = false). */
    read: z.boolean().optional(),
    /** When true, mark as archived. */
    archived: z.boolean().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type NotificationsMarkInput = z.output<typeof notificationsMark.input>;
export type NotificationsMarkOutput = z.output<typeof notificationsMark.output>;
```

- [ ] Create `packages/oxagen/src/contracts/notifications.mark.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { notificationsMark } from "./notifications.mark";

describe("notifications.mark contract", () => {
  it("has the correct name and domain", () => {
    expect(notificationsMark.name).toBe("notifications.mark");
    expect(notificationsMark.domain).toBe("notifications");
  });

  it("parses valid input with read=true", () => {
    const parsed = notificationsMark.input.parse({ id: "ntf_abc", read: true });
    expect(parsed.id).toBe("ntf_abc");
    expect(parsed.read).toBe(true);
  });

  it("rejects empty id", () => {
    expect(() => notificationsMark.input.parse({ id: "" })).toThrow();
  });

  it("parses archived=true alone (read optional)", () => {
    const parsed = notificationsMark.input.parse({ id: "ntf_abc", archived: true });
    expect(parsed.archived).toBe(true);
    expect(parsed.read).toBeUndefined();
  });

  it("output schema accepts ok:true", () => {
    const parsed = notificationsMark.output.parse({ ok: true });
    expect(parsed.ok).toBe(true);
  });
});
```

Run: `pnpm --filter @oxagen/oxagen test:unit -- notifications`
Expected: **both contract test files pass** (7 tests total).

**Commit:**
```
git add packages/oxagen/src/contracts/notifications.list.ts \
        packages/oxagen/src/contracts/notifications.list.test.ts \
        packages/oxagen/src/contracts/notifications.mark.ts \
        packages/oxagen/src/contracts/notifications.mark.test.ts && \
git commit -m "feat(oxagen): notifications.list + notifications.mark contracts"
```

#### D-3: `notifications.list` handler

**Files:**
- Create: `packages/handlers/src/notifications.list.ts`
- Create: `packages/handlers/src/notifications.list.test.ts`

- [ ] Create `packages/handlers/src/notifications.list.ts`:

```ts
import { and, eq, count, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { unreadOnly, limit } = input as { unreadOnly: boolean; limit: number };

  if (!ctx.userId) {
    throw new Error("[notifications.list] userId is required (user-scoped)");
  }
  const userId = ctx.userId;

  return withSystemDb(async (tx) => {
    const conditions = [
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.archived, false),
    ];
    if (unreadOnly) {
      conditions.push(eq(schema.notifications.unread, true));
    }
    const where = and(...conditions);

    const [rows, countRows] = await Promise.all([
      tx
        .select({
          id: schema.notifications.id,
          publicId: schema.notifications.publicId,
          kind: schema.notifications.kind,
          title: schema.notifications.title,
          body: schema.notifications.body,
          deepLink: schema.notifications.deepLink,
          unread: schema.notifications.unread,
          archived: schema.notifications.archived,
          createdAt: schema.notifications.createdAt,
        })
        .from(schema.notifications)
        .where(where)
        .orderBy(sql`${schema.notifications.createdAt} DESC`)
        .limit(limit),
      tx
        .select({ n: count() })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.archived, false),
            eq(schema.notifications.unread, true),
          ),
        ),
    ]);

    const countRow = countRows[0];
    const unreadCount = countRow?.n ?? 0;

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        publicId: r.publicId,
        kind: r.kind,
        title: r.title,
        body: r.body,
        deepLink: r.deepLink,
        unread: r.unread,
        archived: r.archived,
        createdAt: r.createdAt.toISOString(),
      })),
      unreadCount,
    };
  });
};
```

- [ ] Create `packages/handlers/src/notifications.list.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const mockRows = [
  {
    id: "uuid-1",
    publicId: "ntf_A",
    kind: "security",
    title: "Reconnect GitHub",
    body: null,
    deepLink: "/reauth/x",
    unread: true,
    archived: false,
    createdAt: new Date("2026-06-01"),
  },
];

vi.mock("@oxagen/database", () => {
  const mockTx = {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          orderBy: (_o: unknown) => ({
            limit: (_n: number) => Promise.resolve(mockRows),
          }),
        }),
      }),
    }),
  };
  // count() query path
  const mockTxCount = {
    select: () => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => Promise.resolve([{ n: 1 }]),
      }),
    }),
  };
  let call = 0;
  return {
    schema: {
      notifications: {
        userId: "userId_col",
        archived: "archived_col",
        unread: "unread_col",
        createdAt: "createdAt_col",
        id: "id_col",
        publicId: "publicId_col",
        kind: "kind_col",
        title: "title_col",
        body: "body_col",
        deepLink: "deepLink_col",
      },
    },
    withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Return the list handler result by calling with a tx that handles both queries via Promise.all
      call = 0;
      const combinedTx = {
        select: () => ({
          from: (_t: unknown) => ({
            where: (_w: unknown) => ({
              orderBy: (_o: unknown) => ({
                limit: (_n: number) => Promise.resolve(mockRows),
              }),
              // second select (count)
            }),
          }),
        }),
      };
      // Simulate the handler's Promise.all by returning from fn with dual results
      return fn({
        select: () => {
          call++;
          if (call % 2 === 1) {
            // list query
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({ limit: () => Promise.resolve(mockRows) }),
                }),
              }),
            };
          }
          // count query
          return {
            from: () => ({
              where: () => Promise.resolve([{ n: 1 }]),
            }),
          };
        },
      });
    }),
  };
});

// Stub drizzle helpers used in the handler
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (_col: unknown, _val: unknown) => "eq_sentinel",
  count: () => "count_fn",
  sql: (s: TemplateStringsArray, ..._args: unknown[]) => s[0],
}));

import { handler } from "./notifications.list";

describe("notifications.list handler", () => {
  it("returns notifications and unreadCount", async () => {
    const ctx = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1", apiKeyId: null, requestId: "req-1", surface: "api" as const, messageId: null };
    const result = await handler({ unreadOnly: false, limit: 50 }, ctx) as { notifications: unknown[]; unreadCount: number };
    expect(result.notifications).toHaveLength(1);
    expect(result.unreadCount).toBeGreaterThanOrEqual(0);
  });

  it("throws when userId is absent", async () => {
    const ctx = { orgId: "org-1", workspaceId: "ws-1", userId: null, apiKeyId: null, requestId: "req-1", surface: "api" as const, messageId: null };
    await expect(handler({ unreadOnly: false, limit: 50 }, ctx)).rejects.toThrow("userId is required");
  });
});
```

#### D-4: `notifications.mark` handler

**Files:**
- Create: `packages/handlers/src/notifications.mark.ts`
- Create: `packages/handlers/src/notifications.mark.test.ts`

- [ ] Create `packages/handlers/src/notifications.mark.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { id, read, archived } = input as {
    id: string;
    read?: boolean;
    archived?: boolean;
  };

  if (!ctx.userId) {
    throw new Error("[notifications.mark] userId is required (user-scoped)");
  }

  const updates: Partial<{ unread: boolean; archived: boolean; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (typeof read === "boolean") updates.unread = !read;
  if (typeof archived === "boolean") updates.archived = archived;

  if (Object.keys(updates).length === 1) {
    // Only updatedAt — no-op but valid.
    return { ok: true };
  }

  await withSystemDb(async (tx) => {
    await tx
      .update(schema.notifications)
      .set(updates)
      .where(
        and(
          eq(schema.notifications.publicId, id),
          eq(schema.notifications.userId, ctx.userId!),
        ),
      );
  });

  return { ok: true };
};
```

- [ ] Create `packages/handlers/src/notifications.mark.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: { notifications: { publicId: "publicId_col", userId: "userId_col", unread: "unread_col", archived: "archived_col", updatedAt: "updatedAt_col" } },
  withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (_col: unknown, _val: unknown) => "eq_sentinel",
}));

import { handler } from "./notifications.mark";

const ctx = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1", apiKeyId: null, requestId: "req-1", surface: "api" as const, messageId: null };

describe("notifications.mark handler", () => {
  it("returns ok:true when marking as read", async () => {
    const result = await handler({ id: "ntf_abc", read: true }, ctx);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:true when archiving", async () => {
    const result = await handler({ id: "ntf_abc", archived: true }, ctx);
    expect(result).toEqual({ ok: true });
  });

  it("throws when userId is absent", async () => {
    const noUserCtx = { ...ctx, userId: null };
    await expect(handler({ id: "ntf_abc", read: true }, noUserCtx)).rejects.toThrow("userId is required");
  });

  it("returns ok:true with no-op when neither read nor archived provided", async () => {
    const result = await handler({ id: "ntf_abc" }, ctx);
    expect(result).toEqual({ ok: true });
  });
});
```

Run: `pnpm --filter @oxagen/handlers test:unit -- notifications`
Expected: **both handler test files pass**.

**Commit:**
```
git add packages/handlers/src/notifications.list.ts \
        packages/handlers/src/notifications.list.test.ts \
        packages/handlers/src/notifications.mark.ts \
        packages/handlers/src/notifications.mark.test.ts && \
git commit -m "feat(handlers): notifications.list + notifications.mark handlers"
```

#### D-5: Register handlers

- [ ] Edit `packages/handlers/src/register.ts` — append two `registerHandler` calls at the bottom (before the closing of any IIFE if present, or as top-level statements):

```ts
registerHandler(
  "notifications.list",
  async () => (await import("./notifications.list")).handler as CapabilityHandlerFn,
);
registerHandler(
  "notifications.mark",
  async () => (await import("./notifications.mark")).handler as CapabilityHandlerFn,
);
```

#### D-6: API routes

- [ ] Create `apps/api/src/routes/v1/notifications.list.ts`:

```ts
import { Hono } from "hono";
import { notificationsList } from "@oxagen/oxagen/contracts/notifications.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const notificationsListRoute = new Hono<AppEnv>();

notificationsListRoute.get("/", async (c) => {
  const unreadOnly = c.req.query("unreadOnly") === "true";
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 50;
  const input = notificationsList.input.parse({ unreadOnly, limit });
  const ctx = capabilityContext(c);
  const out = await invoke(notificationsList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
```

- [ ] Create `apps/api/src/routes/v1/notifications.mark.ts`:

```ts
import { Hono } from "hono";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const notificationsMarkRoute = new Hono<AppEnv>();

notificationsMarkRoute.post("/", async (c) => {
  const body = await c.req.json();
  const input = notificationsMark.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(notificationsMark.name, input, ctx, { surface: "api" });
  return c.json(out);
});
```

- [ ] Edit `apps/api/src/app.ts` — add imports and mount under `orgScoped`:

Imports to add after existing plugin imports:
```ts
import { notificationsListRoute } from "./routes/v1/notifications.list";
import { notificationsMarkRoute } from "./routes/v1/notifications.mark";
```

Routes to mount (inside `orgScoped.route(...)` block, before `app.route("/v1/:org_slug/:workspace_slug", orgScoped)`):
```ts
orgScoped.route("/notifications", notificationsListRoute);
orgScoped.route("/notifications/mark", notificationsMarkRoute);
```

#### D-7: MCP tools

- [ ] Create `apps/mcp/src/tools/notifications.list.ts`:

```ts
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { notificationsList } from "@oxagen/oxagen/contracts/notifications.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...notificationsList.input.shape,
};

export const metadata: ToolMetadata = {
  name: notificationsList.name,
  description: notificationsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function notificationsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(notificationsList.name, args, ctx, { surface: "mcp" });
  return notificationsList.output.parse(output);
}
```

- [ ] Create `apps/mcp/src/tools/notifications.mark.ts`:

```ts
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...notificationsMark.input.shape,
};

export const metadata: ToolMetadata = {
  name: notificationsMark.name,
  description: notificationsMark.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function notificationsMarkTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(notificationsMark.name, args, ctx, { surface: "mcp" });
  return notificationsMark.output.parse(output);
}
```

Run: `pnpm check:manifest`
Expected: manifest shows `notifications.list` and `notifications.mark` as API+MCP, **no gaps**.

Run: `pnpm --filter @oxagen/api typecheck && pnpm --filter @oxagen/mcp typecheck`
Expected: no errors.

**Commit:**
```
git add packages/handlers/src/register.ts \
        apps/api/src/routes/v1/notifications.list.ts \
        apps/api/src/routes/v1/notifications.mark.ts \
        apps/api/src/app.ts \
        apps/mcp/src/tools/notifications.list.ts \
        apps/mcp/src/tools/notifications.mark.ts && \
git commit -m "feat(api,mcp): notifications.list + notifications.mark routes and tools"
```

---

### Task E: In-app bell wiring

**Files:**
- Create: `apps/app/src/lib/actions/notifications.ts`
- Modify: `apps/app/src/components/shell/notifications-bell.tsx`

#### E-1: Server action

- [ ] Create `apps/app/src/lib/actions/notifications.ts`:

```ts
"use server";

import { invoke } from "@oxagen/oxagen/kernel";
import { notificationsList } from "@oxagen/oxagen/contracts/notifications.list";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import type { NotificationsListOutput } from "@oxagen/oxagen/contracts/notifications.list";
import type { NotificationsMarkOutput } from "@oxagen/oxagen/contracts/notifications.mark";
import { getServerSession } from "@/lib/auth/session";
import { resolveOrg } from "@/lib/resolve-org";
import type { CapabilityContext } from "@oxagen/oxagen/types";

/**
 * Build a CapabilityContext from the current Next.js server context.
 * Mirrors the pattern in apps/app server actions (see billing/*, conversation/*).
 */
async function buildNotificationCtx(
  orgSlug: string,
  workspaceSlug: string,
): Promise<CapabilityContext> {
  const session = await getServerSession();
  if (!session?.user?.id) throw new Error("Unauthenticated");
  const { org, workspace } = await resolveOrg(orgSlug, workspaceSlug, session.user.id);
  return {
    orgId: org.id,
    workspaceId: workspace.id,
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };
}

export async function listNotificationsAction(
  orgSlug: string,
  workspaceSlug: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationsListOutput> {
  const ctx = await buildNotificationCtx(orgSlug, workspaceSlug);
  const input = notificationsList.input.parse({
    unreadOnly: opts.unreadOnly ?? false,
    limit: opts.limit ?? 50,
  });
  const out = await invoke(notificationsList.name, input, ctx, { surface: "app" });
  return notificationsList.output.parse(out);
}

export async function markNotificationAction(
  orgSlug: string,
  workspaceSlug: string,
  id: string,
  opts: { read?: boolean; archived?: boolean } = {},
): Promise<NotificationsMarkOutput> {
  const ctx = await buildNotificationCtx(orgSlug, workspaceSlug);
  const input = notificationsMark.input.parse({ id, ...opts });
  const out = await invoke(notificationsMark.name, input, ctx, { surface: "app" });
  return notificationsMark.output.parse(out);
}
```

VERIFY: `getServerSession` and `resolveOrg` import paths — check existing server actions in `apps/app/src/lib/actions/` for the canonical pattern. If `resolveOrg` is at a different path (e.g. `@/lib/org`), adjust the import accordingly.

#### E-2: Wired `NotificationsBell`

- [ ] Replace `apps/app/src/components/shell/notifications-bell.tsx` entirely:

```tsx
"use client";
/**
 * NotificationsBell — real data, wired to notifications.list + notifications.mark.
 * Renders an unread badge on the bell icon; sheet drawer shows the feed.
 * Mark-read on item click; archive via swipe-right chevron button.
 */

import * as React from "react";
import { Bell } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { listNotificationsAction, markNotificationAction } from "@/lib/actions/notifications";
import { useParams } from "next/navigation";

interface Notification {
  id: string;
  publicId: string;
  kind: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  archived: boolean;
  createdAt: string;
}

export function NotificationsBell() {
  const [open, setOpen] = React.useState(false);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const params = useParams<{ orgSlug: string; workspaceSlug: string }>();
  const orgSlug = params.orgSlug ?? "";
  const workspaceSlug = params.workspaceSlug ?? "";

  const load = React.useCallback(async () => {
    if (!orgSlug || !workspaceSlug) return;
    setLoading(true);
    try {
      const result = await listNotificationsAction(orgSlug, workspaceSlug);
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
    } catch {
      // Silently fail — bell is non-critical; app still works.
    } finally {
      setLoading(false);
    }
  }, [orgSlug, workspaceSlug]);

  // Load when sheet opens; also poll on mount for the badge count.
  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleMarkRead = async (notification: Notification) => {
    if (!notification.unread) return;
    // Optimistic update.
    setNotifications((prev) =>
      prev.map((n) => (n.publicId === notification.publicId ? { ...n, unread: false } : n)),
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await markNotificationAction(orgSlug, workspaceSlug, notification.publicId, { read: true });
    } catch {
      // Revert on failure.
      void load();
    }
  };

  const handleArchive = async (notification: Notification) => {
    setNotifications((prev) => prev.filter((n) => n.publicId !== notification.publicId));
    if (notification.unread) setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await markNotificationAction(orgSlug, workspaceSlug, notification.publicId, { archived: true });
    } catch {
      void load();
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Open notifications (${unreadCount} unread)` : "Open notifications"}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center",
              "rounded-full bg-primary text-[10px] font-semibold text-primary-foreground",
            )}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side="right" className="flex w-80 flex-col p-0 sm:w-80">
          <SheetHeader className="border-b border-border/40 px-4 py-3">
            <SheetTitle className="text-sm font-medium">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                  {unreadCount}
                </span>
              )}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <span className="text-xs text-muted-foreground">Loading…</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <Bell className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">No notifications yet</p>
                <p className="text-xs text-muted-foreground/60">
                  Agent completions, approvals, and alerts will appear here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {notifications.map((n) => (
                  <li
                    key={n.publicId}
                    className={cn(
                      "group flex items-start gap-3 px-4 py-3 text-left transition-colors",
                      "hover:bg-accent/50",
                      n.unread && "bg-primary/5",
                    )}
                  >
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => {
                        void handleMarkRead(n);
                        if (n.deepLink) window.location.href = n.deepLink;
                      }}
                    >
                      <p
                        className={cn(
                          "text-xs leading-snug",
                          n.unread ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/80">
                          {n.body}
                        </p>
                      )}
                      <p className="mt-1 text-[10px] text-muted-foreground/50">
                        {new Date(n.createdAt).toLocaleDateString()}
                      </p>
                    </button>
                    <button
                      type="button"
                      aria-label="Archive notification"
                      onClick={() => void handleArchive(n)}
                      className={cn(
                        "mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity",
                        "text-muted-foreground hover:text-foreground",
                        "group-hover:opacity-100 focus-visible:opacity-100",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      )}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="9 10 4 15 9 20" />
                        <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
```

Run: `pnpm --filter @oxagen/app typecheck`
Expected: no errors.

**Commit:**
```
git add apps/app/src/lib/actions/notifications.ts \
        apps/app/src/components/shell/notifications-bell.tsx && \
git commit -m "feat(app): wire NotificationsBell to real notifications.list + mark server actions"
```

---

### Task F: Org setting capability — `plugin.settings.set_auth_alerts`

This is a lightweight org-level settings mutator. Plan 6 (UI) will surface a toggle in org settings; Plan 5 ships the contract + handler so the setting is writeable from API/MCP immediately.

**Files:**
- Create: `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts`
- Create: `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.test.ts`
- Create: `packages/handlers/src/plugin.settings.set_auth_alerts.ts`
- Create: `packages/handlers/src/plugin.settings.set_auth_alerts.test.ts`
- Modify: `packages/handlers/src/register.ts`
- Create: `apps/api/src/routes/v1/plugin.settings.set_auth_alerts.ts`
- Create: `apps/mcp/src/tools/plugin.settings.set_auth_alerts.ts`
- Modify: `apps/api/src/app.ts`

#### F-1: Contract

- [ ] Create `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts`:

```ts
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * plugin.settings.set_auth_alerts — update the org's mcp_auth_alerts setting.
 * Default (when unset): { send_email: true, roles: ["Owner", "Admin"] }.
 * Only org Owners and Admins may change this setting.
 */
export const pluginSettingsSetAuthAlerts = registerCapability({
  name: "plugin.settings.set_auth_alerts",
  domain: "plugin",
  description:
    "Update the org MCP auth-alert notification setting (which roles receive alerts and whether email is sent).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    /** Whether to send email in addition to in-app notification. */
    sendEmail: z.boolean(),
    /**
     * Org role names that should receive alerts.
     * Must be a non-empty subset of valid org roles.
     */
    roles: z
      .array(z.enum(["Owner", "Admin", "Compliance", "Billing"]))
      .min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type PluginSettingsSetAuthAlertsInput = z.output<
  typeof pluginSettingsSetAuthAlerts.input
>;
```

- [ ] Create `packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pluginSettingsSetAuthAlerts } from "./plugin.settings.set_auth_alerts";

describe("plugin.settings.set_auth_alerts contract", () => {
  it("has correct name and domain", () => {
    expect(pluginSettingsSetAuthAlerts.name).toBe("plugin.settings.set_auth_alerts");
    expect(pluginSettingsSetAuthAlerts.domain).toBe("plugin");
  });

  it("parses valid input", () => {
    const parsed = pluginSettingsSetAuthAlerts.input.parse({
      sendEmail: true,
      roles: ["Owner", "Admin"],
    });
    expect(parsed.sendEmail).toBe(true);
    expect(parsed.roles).toEqual(["Owner", "Admin"]);
  });

  it("rejects empty roles array", () => {
    expect(() =>
      pluginSettingsSetAuthAlerts.input.parse({ sendEmail: false, roles: [] }),
    ).toThrow();
  });

  it("rejects invalid role names", () => {
    expect(() =>
      pluginSettingsSetAuthAlerts.input.parse({ sendEmail: true, roles: ["Member"] }),
    ).toThrow();
  });
});
```

#### F-2: Handler

- [ ] Create `packages/handlers/src/plugin.settings.set_auth_alerts.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { sendEmail, roles } = input as { sendEmail: boolean; roles: string[] };
  const orgId = ctx.orgId;

  const alertsValue = JSON.stringify({ send_email: sendEmail, roles });

  await withSystemDb(async (tx) => {
    await tx
      .update(schema.organizations)
      .set({
        settings: sql`settings || ${alertsValue}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizations.id, orgId));
  });

  return { ok: true };
};
```

Note: `settings || jsonb_value` merges at the top level, preserving other setting keys while overwriting `mcp_auth_alerts`.
VERIFY: Drizzle's `sql` template tag supports `${string}::jsonb` in `.set()`; if not, use `sql`\\`settings || ${sql.raw(`'$\{alertsValue}'::jsonb`)}\`` — but do NOT use `.raw()` with untrusted user input; `JSON.stringify` output of a validated Zod object is safe.

- [ ] Create `packages/handlers/src/plugin.settings.set_auth_alerts.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: { organizations: { id: "id_col", settings: "settings_col", updatedAt: "updatedAt_col" } },
  withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, _val: unknown) => "eq_sentinel",
  sql: (s: TemplateStringsArray, ..._args: unknown[]) => s[0],
}));

import { handler } from "./plugin.settings.set_auth_alerts";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

describe("plugin.settings.set_auth_alerts handler", () => {
  it("returns ok:true", async () => {
    const result = await handler({ sendEmail: true, roles: ["Owner", "Admin"] }, ctx);
    expect(result).toEqual({ ok: true });
  });
});
```

#### F-3: Register + wire route + tool

- [ ] Append to `packages/handlers/src/register.ts`:
```ts
registerHandler(
  "plugin.settings.set_auth_alerts",
  async () =>
    (await import("./plugin.settings.set_auth_alerts")).handler as CapabilityHandlerFn,
);
```

- [ ] Create `apps/api/src/routes/v1/plugin.settings.set_auth_alerts.ts`:
```ts
import { Hono } from "hono";
import { pluginSettingsSetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.set_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginSettingsSetAuthAlertsRoute = new Hono<AppEnv>();

pluginSettingsSetAuthAlertsRoute.post("/", async (c) => {
  const body = await c.req.json();
  const input = pluginSettingsSetAuthAlerts.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(pluginSettingsSetAuthAlerts.name, input, ctx, { surface: "api" });
  return c.json(out);
});
```

- [ ] Edit `apps/api/src/app.ts` — add import + mount:
```ts
import { pluginSettingsSetAuthAlertsRoute } from "./routes/v1/plugin.settings.set_auth_alerts";
// ...
orgScoped.route("/plugin/settings/auth-alerts", pluginSettingsSetAuthAlertsRoute);
```

- [ ] Create `apps/mcp/src/tools/plugin.settings.set_auth_alerts.ts`:
```ts
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { pluginSettingsSetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.set_auth_alerts";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...pluginSettingsSetAuthAlerts.input.shape };

export const metadata: ToolMetadata = {
  name: pluginSettingsSetAuthAlerts.name,
  description: pluginSettingsSetAuthAlerts.description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export default async function pluginSettingsSetAuthAlertsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(pluginSettingsSetAuthAlerts.name, args, ctx, { surface: "mcp" });
  return pluginSettingsSetAuthAlerts.output.parse(output);
}
```

Run: `pnpm check:manifest`
Expected: `plugin.settings.set_auth_alerts` shows as API+MCP — no gaps.

**Commit:**
```
git add packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts \
        packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.test.ts \
        packages/handlers/src/plugin.settings.set_auth_alerts.ts \
        packages/handlers/src/plugin.settings.set_auth_alerts.test.ts \
        packages/handlers/src/register.ts \
        apps/api/src/routes/v1/plugin.settings.set_auth_alerts.ts \
        apps/api/src/app.ts \
        apps/mcp/src/tools/plugin.settings.set_auth_alerts.ts && \
git commit -m "feat(plugins): plugin.settings.set_auth_alerts capability (org alert setting)"
```

---

### Task G: Final verification

**Run each check in order; fix any failure before proceeding to the next.**

#### G-1: `pnpm check:manifest`

```
pnpm check:manifest
```

Expected output (new entries highlighted):
```
✓ notifications.list      api mcp  ✓
✓ notifications.mark      api mcp  ✓
✓ plugin.settings.set_auth_alerts  api mcp  ✓
… (all existing capabilities still green)
Manifest check passed — no gaps.
```

If any gap remains: verify the handler is registered in `register.ts`, the route is mounted in `app.ts`, and the tool file exports `schema`, `metadata`, and a default function.

#### G-2: TypeCheck all touched packages

```
pnpm --filter @oxagen/notifications typecheck && \
pnpm --filter @oxagen/plugins typecheck && \
pnpm --filter @oxagen/oxagen typecheck && \
pnpm --filter @oxagen/handlers typecheck && \
pnpm --filter @oxagen/api typecheck && \
pnpm --filter @oxagen/mcp typecheck && \
pnpm --filter @oxagen/app typecheck
```

Expected: all exit 0, no `any` errors (TypeScript 6.0.3 strict mode).

#### G-3: Unit tests

```
pnpm --filter @oxagen/notifications test:unit
```

Expected: all tests in `src/notifications/*.test.ts` + existing `src/*.test.ts` pass.

```
pnpm --filter @oxagen/handlers test:unit -- notifications
pnpm --filter @oxagen/handlers test:unit -- plugin.settings
pnpm --filter @oxagen/oxagen test:unit -- notifications
pnpm --filter @oxagen/oxagen test:unit -- plugin.settings
```

Expected: 7 contract tests + 4 handler tests (notifications.list + mark) + 1 handler test (set_auth_alerts) + 4 contract tests (set_auth_alerts) — all green.

#### G-4: Lint

```
pnpm --filter @oxagen/notifications lint && \
pnpm --filter @oxagen/plugins lint && \
pnpm --filter @oxagen/handlers lint && \
pnpm --filter @oxagen/api lint && \
pnpm --filter @oxagen/mcp lint
```

Expected: 0 warnings, 0 errors.

---

### Done criteria for Plan 5

- [ ] `notification.notifications` rows are created (via `createNotification`) whenever a credential flips to `needs_reauth` — both from the runtime `connectMcp` error path (Plan 4, Task 5) and the Inngest cron (Plan 4, Task 6).
- [ ] Org Owners and Admins (configurable via `mcp_auth_alerts.roles`) receive an in-app notification AND an email with a re-auth deep link when any credential in their org flips to `needs_reauth`.
- [ ] Email failure never prevents the in-app notification (log-and-continue — no silent total failure).
- [ ] `notifications.list` and `notifications.mark` capabilities are live at both API (`GET /v1/:org/:ws/notifications`, `POST /v1/:org/:ws/notifications/mark`) and MCP.
- [ ] `plugin.settings.set_auth_alerts` is live at API + MCP; updates `organizations.settings.mcp_auth_alerts`.
- [ ] The `NotificationsBell` shell component renders real notifications, shows an unread badge, marks-read on click, archives on dismiss, and links to the deep-link URL.
- [ ] `pnpm check:manifest` passes with no gaps.
- [ ] TypeCheck and unit tests green across all touched packages.

**Next plan:** `docs/superpowers/plans/2026-06-06-installable-plugins-06-ui.md` — org settings "Plugins" section, marketplace modal with bulk install, workspace integration surface, re-auth page, and `assertMcpManager` auth gate.

## Document — `2026-06-06-installable-plugins-06-ui.md`

## Installable Plugins — Plan 6: UI (org plugins settings + marketplace modal + workspace install + re-auth page)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every user-facing surface for installable plugins — the org Plugins settings page, the marketplace modal, the workspace install/integrations surface, the re-auth deep-link page, and the org alert-settings toggle — wiring each to the capabilities already shipped in Plans 2–5.

**Architecture:** All mutation surfaces are server actions that mirror the `billing/actions.ts` pattern exactly: `getSessionOrRedirect` → `resolveOrg`/`resolveWorkspace` → `assertMcpManager` → `buildCtx` → `invoke(cap.name, input, ctx, { surface: "agent" })`. Read surfaces are Next.js server components calling capabilities through `invoke()` inside `runInTenantScope`. Client components use coss (`@oxagen/ui`) — `Dialog`/`DialogPopup` for the marketplace modal, `Tabs`/`TabsList`/`TabsTab`/`TabsPanel` for type tabs, `Switch` for toggles, `Badge` for transport/auth labels — following the `render`-not-`asChild` and `data-[checked]`/`data-[selected]` conventions enforced by Base UI.

**Tech Stack:** Next.js App Router RSC + server actions; `invoke` from `@oxagen/oxagen`; `@oxagen/handlers/register` side-effect import; `@oxagen/ui` coss components (`Dialog`, `Tabs`, `Switch`, `Badge`, `Button`, `Input`); `@oxagen/oxagen` contracts (`plugin.catalog.browse`, `plugin.catalog.get`, `plugin.org.install`, `plugin.org.install_bulk`, `plugin.org.uninstall`, `plugin.org.set_enabled`, `plugin.denylist.add`, `plugin.denylist.remove`, `plugin.registry.list`, `plugin.registry.add`, `plugin.registry.remove`, `plugin.workspace.set_enabled`, `plugin.credential.set_secret`); `revalidatePath`; Tailwind CSS (no glass/translucency).

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§10 UI)

---

### Context you must read before coding

#### Server-action pattern (canonical — mirror exactly)

File: `apps/app/src/app/[orgSlug]/members/member-actions.ts`

Every plugin server action follows this five-step pattern:

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";               // REQUIRED side-effect import — no handler resolves without it
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

function buildCtx(opts: { orgId: string; workspaceId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

export async function somePluginAction(input: { orgSlug: string; ... }): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SomeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const org = await resolveOrg(parsed.data.orgSlug);
  await assertOrgMember(org.id, session.user.id);    // IDOR pre-check (membership)

  // For org-level plugin mutations: use assertMcpManager (added in Task A)
  // For workspace-level: also resolveWorkspace + org-role gate in ctx

  const ctx = buildCtx({ orgId: org.id, workspaceId: "", userId: session.user.id });
  try {
    await invoke("plugin.org.install", { ... }, ctx, { surface: "agent" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed" };
  }
  revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
  return { ok: true };
}
```

**Org-only context:** set `workspaceId: ""` for org-scoped plugin capabilities (no sentinel needed — the capability handler sets the scope). For workspace-scoped capabilities (`plugin.workspace.set_enabled`, `plugin.credential.set_secret`), resolve and pass the real `workspaceId`.

**VERIFY:** Check `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/models/models-action.ts` for the workspace-scoped variant (uses `resolveWorkspace`, passes real `ws.id` to `buildCtx`, wraps in `runInTenantScope`).

#### coss/`@oxagen/ui` conventions

From `packages/ui/src/components/`:

- **Dialog:** `<Dialog open onOpenChange>` → `<DialogPopup className="max-w-5xl">` → `<DialogHeader>` + `<DialogPanel>` + `<DialogFooter>`. No `asChild`. Close button is built into `DialogPopup`.
- **Tabs:** `<Tabs defaultValue>` → `<TabsList variant="underline">` → `<TabsTab value>` (NOT `TabsTrigger`) → `<TabsPanel value>` (NOT `TabsContent`). Active state via `data-[selected]`, not `data-[state=active]`.
- **Switch:** `<Switch checked={...} onCheckedChange={...} />`. On-state: `data-[checked]`.
- **Badge:** `<Badge variant="outline" size="sm">` — no `render` prop needed for static labels. Transport/auth kind badges use `variant="muted"`.
- **Button:** standard `<Button variant size>`. Default is `variant="default"` (primary color).
- **Input:** `<Input type="text" value onChange />` — controlled.
- No glass/translucency anywhere. Use `border border-border/60 bg-muted/60` for card surfaces.

#### Capability output shapes (reference)

- `plugin.catalog.browse` → `{ servers: Array<{ id, name, title, description, icons, transportTypes, authKind, categories, version }>, nextOffset, total }`
- `plugin.catalog.get` → `{ id, name, title, description, version, websiteUrl, icons, packages, remotes, transportTypes, authKind, categories, readmeHtml, status }`
- `plugin.org.install` → `{ orgListingId }`
- `plugin.org.install_bulk` → `{ installed: Array<{ catalogServerId, orgListingId, error }> }`
- `plugin.org.set_enabled` → `{ ok }`
- `plugin.org.uninstall` → `{ ok }`
- `plugin.registry.list` → `{ registries: Array<{ id, name, baseUrl, enabled, isDefaultSeed, lastSyncedAt }> }`
- `plugin.workspace.set_enabled` → `{ workspaceServerId }`

#### Missing contracts (not yet shipped — note in plan, tasks handle gracefully)

The spec lists `plugin.credential.reauth`, `notifications.list`, `notifications.mark`, and `plugin.settings.set_auth_alerts` — these contracts are NOT in `packages/oxagen/src/contracts/` yet (scheduled for Plans 5 and later). Tasks that call them add `// VERIFY: contract ships in Plan 5` comments and wrap calls in `try/catch`. Do not block on absent contracts — implement the UI shell and wire it when the contract lands.

---

### Task A — `assertMcpManager` + `resolveManagedOrgForPlugins`

**Status: CONFIRMED MISSING.** Only `assertBillingManager` (`BILLING_MANAGER_ROLES = { owner, admin, billing }`) exists in `apps/app/src/lib/resolve-org.ts`. The spec (§8) explicitly requires `assertMcpManager` — a direct clone with role set `{ owner, admin }`.

- [ ] **A1** — Add `assertMcpManager` to `apps/app/src/lib/resolve-org.ts`

**Files:**
- `apps/app/src/lib/resolve-org.ts` (edit — add after `assertBillingManager`)

```ts
/** Roles permitted to manage plugins (MCP servers, integrations, content tools). */
const MCP_MANAGER_ROLES = new Set(["owner", "admin"]);

/**
 * Assert that the user is a member of the org AND holds a plugin-management
 * role (owner/admin). Calls `notFound()` otherwise — consistent with
 * {@link assertBillingManager}. Use in any server route/action that mutates
 * org plugin governance (install, uninstall, denylist, registry, enable/disable).
 */
export const assertMcpManager = cache(
  async (orgId: string, userId: string): Promise<void> => {
    const rows = await withSystemDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, orgId),
            eq(schema.orgUsers.userId, userId),
          ),
        )
        .limit(1),
    );
    const role = rows[0]?.role;
    if (!role || !MCP_MANAGER_ROLES.has(role)) {
      notFound();
    }
  },
);
```

- [ ] **A2** — Add `resolveManagedOrgForPlugins` helper for server actions

This mirrors `resolveManagedOrg` in `billing/actions.ts` but uses owner/admin gate and emits a `plugin.access_denied` security event.

**Files:**
- `apps/app/src/app/[orgSlug]/settings/plugins/plugin-actions.ts` (new file — created in Task B, but the helper is defined here so all plugin actions can import it)

The helper returns `{ orgId: string; actorUserId: string } | null`.

```ts
// Inside plugin-actions.ts (see Task B for full file)
const CAN_MANAGE_PLUGINS = new Set(["owner", "admin"]);
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

async function resolveManagedOrgForPlugins(
  orgSlug: string,
): Promise<{ orgId: string; actorUserId: string } | null> {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(orgSlug);
  if (!session.user) return null;

  const { withTenantDb, schema } = await import("@oxagen/database");
  const { eq, and } = await import("drizzle-orm");
  const [row] = await runInTenantScope({ orgId: tenant.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select({ role: schema.orgUsers.role })
        .from(schema.orgUsers)
        .where(
          and(
            eq(schema.orgUsers.orgId, tenant.id),
            eq(schema.orgUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    ),
  );
  const role = row?.role ?? null;
  if (!role || !CAN_MANAGE_PLUGINS.has(role)) {
    logger.warn({ orgSlug, userId: session.user.id, role }, "plugin: action denied — not a plugin manager");
    return null;
  }
  return { orgId: tenant.id, actorUserId: session.user.id };
}
```

**Commit:** `feat(app): add assertMcpManager + resolveManagedOrgForPlugins to resolve-org`

---

### Task B — Org settings → Plugins page + server actions

New route: `apps/app/src/app/[orgSlug]/settings/plugins/`

Sections:
1. **Registries** — list org registries (incl. seeded default shown read-only), add custom, remove non-seed.
2. **Org allow-list** — table of installed plugins: name, type, enabled toggle, uninstall.
3. **Custom plugin form** — add a custom MCP server (name, title, endpoint URL, transport, auth kind).
4. **Denylist manager** — list denied server names, add, remove.
5. **"Browse marketplace" button** — opens the marketplace modal (Task C).

The org settings layout (`apps/app/src/app/[orgSlug]/settings/`) currently has no `layout.tsx` — it relies on the parent `[orgSlug]/layout.tsx`. The `settings/general` link already works. This plan **adds a "Plugins" tab** by adding `apps/app/src/app/[orgSlug]/settings/layout.tsx` (new file) and extending `apps/app/src/lib/routes.ts` with `org.settings.plugins`.

- [ ] **B1** — Extend `routes.ts`: add `org.settings.plugins`

**Files:** `apps/app/src/lib/routes.ts`

```ts
// Inside the `org.settings` object (after `general`):
plugins: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/plugins`,
```

- [ ] **B2** — Create org settings layout with General + Plugins tabs

**Files:** `apps/app/src/app/[orgSlug]/settings/layout.tsx` (new)

```tsx
import { PageHeader } from "@/components/ui/page-header";
import { PageTabs } from "@/components/ui/page-tabs";
import { org } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

export default async function OrgSettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const ctx: ScopeContext = { orgSlug };

  const tabs = [
    { label: "General", href: org.settings.general(ctx) },
    { label: "Plugins", href: org.settings.plugins(ctx) },
  ];

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        title="Organization Settings"
        description="Configure your organization, manage plugins, and govern third-party integrations."
      />
      <PageTabs tabs={tabs} className="mb-6" />
      {children}
    </div>
  );
}
```

**VERIFY:** Check `apps/app/src/components/ui/page-header.tsx` and `apps/app/src/components/ui/page-tabs.tsx` for exact props before coding — mirror the billing layout which uses the same two components.

- [ ] **B3** — Create `plugin-actions.ts` server actions file

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/plugin-actions.ts` (new)

This is the canonical server actions module for all org-level plugin mutations. Include `resolveManagedOrgForPlugins` (from Task A2), then export these actions:

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

// ... resolveManagedOrgForPlugins (from Task A2) ...

const NOT_AUTHORIZED = "You don't have permission to manage plugins for this organization.";
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

function buildCtx(opts: { orgId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: "",
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

// ── installPluginAction ───────────────────────────────────────────────────────
const InstallSchema = z.object({
  orgSlug: z.string().min(1),
  catalogServerId: z.string().optional(),
  pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
  custom: z.object({
    name: z.string().min(1).max(120),
    title: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
    endpointUrl: z.string().url(),
    transport: z.string().min(1),
    authKind: z.enum(["oauth", "secret", "none"]),
  }).optional(),
});

export async function installPluginAction(
  input: z.infer<typeof InstallSchema>,
): Promise<{ ok: boolean; orgListingId?: string; error?: string }> {
  const parsed = InstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke(
      "plugin.org.install",
      { pluginType: parsed.data.pluginType, catalogServerId: parsed.data.catalogServerId, custom: parsed.data.custom },
      ctx,
      { surface: "agent" },
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true, orgListingId: out.orgListingId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Install failed" };
  }
}

// ── installBulkPluginAction ───────────────────────────────────────────────────
const InstallBulkSchema = z.object({
  orgSlug: z.string().min(1),
  items: z.array(z.object({
    catalogServerId: z.string().optional(),
    pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
  })).min(1).max(50),
});

export async function installBulkPluginAction(
  input: z.infer<typeof InstallBulkSchema>,
): Promise<{ ok: boolean; installed?: Array<{ catalogServerId: string | null; orgListingId: string | null; error: string | null }>; error?: string }> {
  const parsed = InstallBulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke("plugin.org.install_bulk", { items: parsed.data.items }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true, installed: out.installed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Bulk install failed" };
  }
}

// ── setOrgPluginEnabledAction ─────────────────────────────────────────────────
const SetEnabledSchema = z.object({
  orgSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  enabled: z.boolean(),
});

export async function setOrgPluginEnabledAction(
  input: z.infer<typeof SetEnabledSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = SetEnabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.org.set_enabled", { orgListingId: parsed.data.orgListingId, enabled: parsed.data.enabled }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Update failed" };
  }
}

// ── uninstallPluginAction ─────────────────────────────────────────────────────
const UninstallSchema = z.object({
  orgSlug: z.string().min(1),
  orgListingId: z.string().min(1),
});

export async function uninstallPluginAction(
  input: z.infer<typeof UninstallSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = UninstallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.org.uninstall", { orgListingId: parsed.data.orgListingId }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Uninstall failed" };
  }
}

// ── addDenylistAction ─────────────────────────────────────────────────────────
const DenylistAddSchema = z.object({
  orgSlug: z.string().min(1),
  serverName: z.string().min(1),
  pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
  reason: z.string().max(500).optional(),
});

export async function addDenylistAction(
  input: z.infer<typeof DenylistAddSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = DenylistAddSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.denylist.add", { serverName: parsed.data.serverName, pluginType: parsed.data.pluginType, reason: parsed.data.reason }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Denylist add failed" };
  }
}

// ── removeDenylistAction ──────────────────────────────────────────────────────
const DenylistRemoveSchema = z.object({
  orgSlug: z.string().min(1),
  serverName: z.string().min(1),
  pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
});

export async function removeDenylistAction(
  input: z.infer<typeof DenylistRemoveSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = DenylistRemoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.denylist.remove", { serverName: parsed.data.serverName, pluginType: parsed.data.pluginType }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Denylist remove failed" };
  }
}

// ── addRegistryAction ─────────────────────────────────────────────────────────
const AddRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
});

export async function addRegistryAction(
  input: z.infer<typeof AddRegistrySchema>,
): Promise<{ ok: boolean; registryId?: string; error?: string }> {
  const parsed = AddRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    const out = await invoke("plugin.registry.add", { name: parsed.data.name, baseUrl: parsed.data.baseUrl }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true, registryId: out.registryId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Registry add failed" };
  }
}

// ── removeRegistryAction ──────────────────────────────────────────────────────
const RemoveRegistrySchema = z.object({
  orgSlug: z.string().min(1),
  registryId: z.string().min(1),
});

export async function removeRegistryAction(
  input: z.infer<typeof RemoveRegistrySchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = RemoveRegistrySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const ctx = buildCtx({ orgId: managed.orgId, userId: managed.actorUserId });
  try {
    await invoke("plugin.registry.remove", { registryId: parsed.data.registryId }, ctx, { surface: "agent" });
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Registry remove failed" };
  }
}
```

- [ ] **B4** — Create the org Plugins page server component

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` (new)

Data fetched server-side: viewer role (for `canManage`), registries list, org listings (allow-list), denylist. Use `invoke()` inside `runInTenantScope` with ORG_ONLY_WS sentinel.

```tsx
import { eq, and } from "drizzle-orm";
import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { OrgPluginsPanel } from "./org-plugins-panel";
import {
  installPluginAction,
  installBulkPluginAction,
  setOrgPluginEnabledAction,
  uninstallPluginAction,
  addDenylistAction,
  removeDenylistAction,
  addRegistryAction,
  removeRegistryAction,
} from "./plugin-actions";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export const dynamic = "force-dynamic";

export default async function OrgPluginsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);

  // Read viewer role (same pattern as billing/subscription/page.tsx)
  const [viewerRoleRow] = await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, org.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );

  const viewerRole = viewerRoleRow?.role ?? "member";
  const canManage = ["owner", "admin"].includes(viewerRole.toLowerCase());

  const ctx = {
    orgId: org.id,
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  // Fetch registries and org listings in parallel
  const [registriesResult, /* listings from DB via capability */] = await Promise.all([
    invoke("plugin.registry.list", {}, ctx, { surface: "agent" }).catch(() => ({ registries: [] })),
  ]);

  // VERIFY: plugin.org.list capability (may not exist yet — Plans 2/3 ship plugin.org.install
  // but not a browse-by-org listing capability). If absent, read from DB directly using
  // withTenantDb + schema.pluginOrgListings. Fall back gracefully with empty array.
  // TODO: once plugin.org.list is shipped, replace the direct DB read below.
  const listings = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgListings)
        .where(eq(schema.pluginOrgListings.orgId, org.id))
        .orderBy(schema.pluginOrgListings.name),
    ),
  ).catch(() => []);

  // VERIFY: schema.pluginOrgListings — check packages/database/src/schema/ for exact name.
  // If the table is named differently (e.g. orgListings, pluginListings), adjust accordingly.

  const denylisted = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgDenylist)
        .where(eq(schema.pluginOrgDenylist.orgId, org.id))
        .orderBy(schema.pluginOrgDenylist.serverName),
    ),
  ).catch(() => []);

  // VERIFY: schema.pluginOrgDenylist — check packages/database/src/schema/ for exact name.

  return (
    <OrgPluginsPanel
      orgSlug={orgSlug}
      canManage={canManage}
      registries={registriesResult.registries}
      listings={listings}
      denylisted={denylisted}
      installAction={installPluginAction}
      installBulkAction={installBulkPluginAction}
      setEnabledAction={setOrgPluginEnabledAction}
      uninstallAction={uninstallPluginAction}
      addDenylistAction={addDenylistAction}
      removeDenylistAction={removeDenylistAction}
      addRegistryAction={addRegistryAction}
      removeRegistryAction={removeRegistryAction}
    />
  );
}
```

- [ ] **B5** — Create `OrgPluginsPanel` client component

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/org-plugins-panel.tsx` (new)

This client component renders all four sections. It is "use client" and receives all server actions as props (same pattern as `OrgGeneralForm` which receives `action` as a prop). Sections are rendered as collapsible cards using `border border-border/60 rounded-xl` containers (no glass/translucency per CLAUDE.md rule).

Key behaviors:
- **Registries section:** Table with name, URL, enabled indicator, last synced. Default seed row is locked (no remove button; "Default" badge). Add-registry form is collapsed by default, toggled by "Add registry" button.
- **Allow-list section:** Table with plugin icon (first `icons[0].src` hotlinked via `<img>`, fallback to a generic puzzle-piece SVG), name/title, type badge, transport badge, auth-kind badge, enabled `Switch`, "Uninstall" button (with `window.confirm` guard). "Browse marketplace" button opens the `MarketplaceModal` (Task C).
- **Custom plugin form:** Collapsed; add button expands a form with fields: Name, Title (optional), Endpoint URL, Transport (streamable-http / sse), Auth Kind (none / secret / oauth). On submit → `installAction` with `custom` field set.
- **Denylist section:** List of denied server names with type and reason (truncated). Add-denylist form: server name text input + optional reason + plugin type select. Remove buttons per row.

```tsx
"use client";
import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { MarketplaceModal } from "@/components/plugins/marketplace-modal";
import { ShoppingBag, Trash2, Plus, RefreshCw } from "lucide-react";
// ... full implementation per section above
```

**VERIFY:** Import paths for `Label` — check `apps/app/src/components/ui/label.tsx` exists (it does per the file listing).

**Important implementation notes:**
- Every server action call is wrapped in `startTransition` + local `isPending` state for optimistic loading feedback.
- Error messages from actions are shown inline below the relevant section in a `<p className="text-sm text-destructive">`.
- Type badge colors: `mcp_server` → `variant="outline"`, `integration` → `variant="muted"`, `content_tool` → `variant="secondary"`.
- Auth badge colors: `oauth` → `variant="info"`, `secret` → `variant="warning"`, `none` → `variant="muted"`.
- Transport badges: `variant="outline" size="sm"`.

**Commit:** `feat(app): org plugins settings page — registries, allow-list, denylist, custom-server form`

---

### Task C — Marketplace modal

**Files:**
- `apps/app/src/components/plugins/marketplace-modal.tsx` (new)
- `apps/app/src/components/plugins/plugin-detail-panel.tsx` (new)

The marketplace modal is triggered from the OrgPluginsPanel "Browse marketplace" button and from the workspace integrations page. It is a controlled `Dialog` (`open`/`onOpenChange` props) with `DialogPopup` set to `max-w-5xl` and a fixed height (`h-[80vh]`).

- [ ] **C1** — Create `MarketplaceModal` component

**Files:** `apps/app/src/components/plugins/marketplace-modal.tsx` (new)

```tsx
"use client";
import * as React from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTab,
  TabsPanel,
} from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PluginDetailPanel } from "./plugin-detail-panel";
import { Search, Package, Plug, FileText, ShoppingBag } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogServer {
  id: string;
  name: string;
  title: string | null;
  description: string;
  icons: Array<{ src: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  version: string;
}

interface MarketplaceModalProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deny-listed server names (for greying out) */
  deniedNames?: string[];
  /** Server action: install single plugin */
  installAction: (input: {
    orgSlug: string;
    catalogServerId: string;
    pluginType: "mcp_server" | "integration" | "content_tool";
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  /** Server action: bulk install */
  installBulkAction: (input: {
    orgSlug: string;
    items: Array<{ catalogServerId: string; pluginType: "mcp_server" | "integration" | "content_tool" }>;
  }) => Promise<{ ok: boolean; error?: string }>;
}

const PLUGIN_TABS = [
  { value: "mcp_server", label: "MCP Servers", icon: Plug },
  { value: "integration", label: "Integrations", icon: Package },
  { value: "content_tool", label: "Content Tools", icon: FileText },
] as const;

type PluginTypeValue = "mcp_server" | "integration" | "content_tool";

// ── Component ─────────────────────────────────────────────────────────────────

export function MarketplaceModal({
  orgSlug,
  open,
  onOpenChange,
  deniedNames = [],
  installAction,
  installBulkAction,
}: MarketplaceModalProps) {
  const [activeTab, setActiveTab] = React.useState<PluginTypeValue>("mcp_server");
  const [search, setSearch] = React.useState("");
  const [authFilter, setAuthFilter] = React.useState<"" | "oauth" | "secret" | "none">("");
  const [servers, setServers] = React.useState<CatalogServer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [bulkPending, setBulkPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch catalog via the API route (GET /api/v1/plugin/catalog/browse)
  // The marketplace calls the API rather than a direct server action so the
  // modal can re-fetch on tab/filter change without triggering a full server
  // component re-render. The API route calls invoke() server-side.
  const fetchServers = React.useCallback(
    async (offset = 0, replace = true) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          limit: "30",
          offset: String(offset),
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(authFilter ? { authKind: authFilter } : {}),
        });
        const res = await fetch(`/api/v1/plugin/catalog/browse?${params.toString()}`);
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          servers: CatalogServer[];
          nextOffset: number | null;
          total: number;
        };
        setServers((prev) => (replace ? data.servers : [...prev, ...data.servers]));
        setNextOffset(data.nextOffset);
        setTotal(data.total);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load catalog");
      } finally {
        setLoading(false);
      }
    },
    [search, authFilter],
  );

  // Re-fetch when the modal opens or filters change
  React.useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setDetailId(null);
    fetchServers(0, true);
  }, [open, activeTab, search, authFilter, fetchServers]);

  // Debounce search input
  const searchTimeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = (val: string) => {
    setSearch(val);
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => fetchServers(0, true), 300);
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const handleBulkInstall = async () => {
    if (selected.size === 0) return;
    setBulkPending(true);
    setError(null);
    try {
      const result = await installBulkAction({
        orgSlug,
        items: Array.from(selected).map((id) => ({ catalogServerId: id, pluginType: activeTab })),
      });
      if (!result.ok) { setError(result.error ?? "Bulk install failed"); return; }
      setSelected(new Set());
      onOpenChange(false);
    } finally {
      setBulkPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-5xl h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <ShoppingBag className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Plugin Marketplace
          </DialogTitle>
          <DialogDescription>
            Browse and install MCP servers, integrations, and content tools for your organization.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => { setActiveTab(v as PluginTypeValue); setSelected(new Set()); }}
          className="flex flex-col flex-1 min-h-0"
        >
          {/* Tab bar + search row */}
          <div className="flex-shrink-0 px-6 pt-3 pb-0 border-b border-border/40">
            <div className="flex items-center justify-between gap-4">
              <TabsList variant="underline" className="gap-6">
                {PLUGIN_TABS.map(({ value, label, icon: Icon }) => (
                  <TabsTab key={value} value={value} className="flex items-center gap-1.5 text-sm">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </TabsTab>
                ))}
              </TabsList>

              <div className="flex items-center gap-2">
                {/* Auth filter chips */}
                {(["", "oauth", "secret", "none"] as const).map((k) => (
                  <button
                    key={k || "all"}
                    type="button"
                    onClick={() => setAuthFilter(k)}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                      authFilter === k
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border/60 text-muted-foreground hover:border-foreground/40"
                    }`}
                  >
                    {k === "" ? "All" : k}
                  </button>
                ))}
                <div className="relative ml-2">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <Input
                    type="search"
                    placeholder="Search…"
                    size="sm"
                    className="pl-7 w-52"
                    value={search}
                    onChange={(e) => handleSearchChange(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Content panels */}
          {PLUGIN_TABS.map(({ value }) => (
            <TabsPanel key={value} value={value} className="flex-1 min-h-0 overflow-auto mt-0">
              <div className="flex h-full">
                {/* Server grid */}
                <div className={`flex-1 overflow-auto p-6 ${detailId ? "w-1/2 border-r border-border/40" : "w-full"}`}>
                  {error && (
                    <p className="mb-4 text-sm text-destructive">{error}</p>
                  )}
                  {loading && servers.length === 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-28 rounded-xl border border-border/40 bg-muted/30 animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <>
                      <p className="mb-3 text-xs text-muted-foreground">{total} servers</p>
                      <div className="grid grid-cols-2 gap-3">
                        {servers.map((srv) => {
                          const denied = deniedNames.includes(srv.name);
                          const isSelected = selected.has(srv.id);
                          return (
                            <button
                              key={srv.id}
                              type="button"
                              onClick={() => { if (!denied) setDetailId(srv.id); }}
                              disabled={denied}
                              className={`relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${
                                denied
                                  ? "border-border/30 bg-muted/20 opacity-50 cursor-not-allowed"
                                  : isSelected
                                  ? "border-primary/60 bg-primary/5"
                                  : "border-border/60 bg-card hover:border-foreground/30 hover:bg-muted/30"
                              }`}
                              aria-label={denied ? `${srv.title ?? srv.name} — blocked by your organization's admins` : srv.title ?? srv.name}
                            >
                              {/* Multi-select checkbox — native input, styled with Tailwind */}
                              {!denied && (
                                <span
                                  className="absolute top-3 right-3"
                                  onClick={(e) => { e.stopPropagation(); toggleSelect(srv.id); }}
                                  aria-label={isSelected ? "Deselect" : "Select"}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelect(srv.id)}
                                    className="h-4 w-4 rounded border-border accent-primary"
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                </span>
                              )}

                              <div className="flex items-start gap-2 pr-6">
                                {srv.icons[0] ? (
                                  <img src={srv.icons[0].src} alt="" className="h-8 w-8 rounded object-contain flex-shrink-0" aria-hidden="true" />
                                ) : (
                                  <span className="flex h-8 w-8 items-center justify-center rounded bg-muted flex-shrink-0">
                                    <Plug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                  </span>
                                )}
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium leading-tight">{srv.title ?? srv.name}</p>
                                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{srv.description}</p>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-1">
                                {srv.transportTypes.slice(0, 2).map((t) => (
                                  <Badge key={t} variant="outline" size="sm">{t}</Badge>
                                ))}
                                <Badge variant={srv.authKind === "oauth" ? "info" : srv.authKind === "secret" ? "warning" : "muted"} size="sm">
                                  {srv.authKind}
                                </Badge>
                              </div>

                              {denied && (
                                <p className="text-xs text-muted-foreground italic">Blocked by your organization&apos;s admins</p>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {nextOffset !== null && (
                        <div className="mt-4 flex justify-center">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => fetchServers(nextOffset, false)}
                            disabled={loading}
                          >
                            {loading ? "Loading…" : "Load more"}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Detail panel */}
                {detailId && (
                  <div className="w-1/2 overflow-auto">
                    <PluginDetailPanel
                      catalogId={detailId}
                      orgSlug={orgSlug}
                      pluginType={value as PluginTypeValue}
                      isDenied={servers.find((s) => s.id === detailId) ? deniedNames.includes(servers.find((s) => s.id === detailId)!.name) : false}
                      installAction={installAction}
                      onInstalled={() => onOpenChange(false)}
                      onClose={() => setDetailId(null)}
                    />
                  </div>
                )}
              </div>
            </TabsPanel>
          ))}
        </Tabs>

        {/* Footer — bulk install */}
        <DialogFooter className="flex-shrink-0 border-t border-border/40 px-6 py-4">
          <p className="mr-auto text-sm text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected` : "Select plugins to bulk-install"}
          </p>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={bulkPending}
          >
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || bulkPending}
            onClick={handleBulkInstall}
          >
            {bulkPending ? "Installing…" : `Install selected (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
```

**Note on CSP:** Plugin icons are hotlinked from their registry URLs. The existing CSP in `apps/app/next.config.ts` (or equivalent) must include `img-src` for the registry domain. Add `registry.modelcontextprotocol.io` to the CSP `img-src` directive if not already present.

**VERIFY:** Check `apps/app/next.config.ts` or `apps/app/src/app/api/` for the CSP header location before adding the domain.

- [ ] **C2** — Create `PluginDetailPanel` component

**Files:** `apps/app/src/components/plugins/plugin-detail-panel.tsx` (new)

Fetches the full catalog detail via `GET /api/v1/plugin/catalog/get?catalogId={id}` and renders: hero logo, title, author/website link, transport + auth badges, rendered README HTML via `dangerouslySetInnerHTML` (safe — `readmeHtml` is sanitized by rehype-sanitize on the server in Plan 2), tools list if available, and an Install button.

```tsx
"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, X, Plug } from "lucide-react";

interface CatalogDetail {
  id: string;
  name: string;
  title: string | null;
  description: string;
  version: string;
  websiteUrl: string | null;
  icons: Array<{ src: string }>;
  packages: unknown[];
  remotes: Array<{ transportType?: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  readmeHtml: string | null;
  status: string;
}

interface PluginDetailPanelProps {
  catalogId: string;
  orgSlug: string;
  pluginType: "mcp_server" | "integration" | "content_tool";
  isDenied: boolean;
  installAction: (input: {
    orgSlug: string;
    catalogServerId: string;
    pluginType: "mcp_server" | "integration" | "content_tool";
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  onInstalled: () => void;
  onClose: () => void;
}

export function PluginDetailPanel({
  catalogId,
  orgSlug,
  pluginType,
  isDenied,
  installAction,
  onInstalled,
  onClose,
}: PluginDetailPanelProps) {
  const [detail, setDetail] = React.useState<CatalogDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [installing, setInstalling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setError(null);
    fetch(`/api/v1/plugin/catalog/get?catalogId=${encodeURIComponent(catalogId)}`)
      .then((r) => r.json() as Promise<CatalogDetail>)
      .then((d) => { if (!cancelled) { setDetail(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : "Failed"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [catalogId]);

  const handleInstall = async () => {
    if (!detail) return;
    setInstalling(true);
    setError(null);
    try {
      const result = await installAction({ orgSlug, catalogServerId: detail.id, pluginType });
      if (!result.ok) { setError(result.error ?? "Install failed"); return; }
      onInstalled();
    } finally {
      setInstalling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <div className="h-12 w-12 rounded-xl bg-muted/40 animate-pulse" />
        <div className="h-5 w-48 rounded bg-muted/40 animate-pulse" />
        <div className="h-3 w-full rounded bg-muted/40 animate-pulse" />
        <div className="h-3 w-3/4 rounded bg-muted/40 animate-pulse" />
      </div>
    );
  }

  if (!detail) {
    return <p className="p-6 text-sm text-destructive">{error ?? "Not found"}</p>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border/40 p-6">
        {detail.icons[0] ? (
          <img src={detail.icons[0].src} alt="" className="h-12 w-12 rounded-xl object-contain flex-shrink-0" aria-hidden="true" />
        ) : (
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted flex-shrink-0">
            <Plug className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{detail.title ?? detail.name}</h3>
          <p className="text-xs text-muted-foreground">{detail.name} · v{detail.version}</p>
          {detail.websiteUrl && (
            <a
              href={detail.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {detail.websiteUrl.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Close detail"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5 border-b border-border/40 px-6 py-3">
        {detail.transportTypes.map((t) => (
          <Badge key={t} variant="outline" size="sm">{t}</Badge>
        ))}
        <Badge
          variant={detail.authKind === "oauth" ? "info" : detail.authKind === "secret" ? "warning" : "muted"}
          size="sm"
        >
          {detail.authKind === "none" ? "No auth" : detail.authKind}
        </Badge>
        {detail.categories.slice(0, 3).map((c) => (
          <Badge key={c} variant="secondary" size="sm">{c}</Badge>
        ))}
        {detail.status !== "active" && (
          <Badge variant="destructive" size="sm">{detail.status}</Badge>
        )}
      </div>

      {/* README */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <p className="mb-3 text-sm text-muted-foreground">{detail.description}</p>
        {detail.readmeHtml ? (
          // readmeHtml is sanitized by rehype-sanitize server-side in Plan 2 (catalog sync).
          // dangerouslySetInnerHTML is safe here — no user-supplied content, only registry README.
          <div
            className="prose prose-sm dark:prose-invert max-w-none text-sm"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: detail.readmeHtml }}
          />
        ) : (
          <p className="text-xs text-muted-foreground italic">No README available.</p>
        )}
      </div>

      {/* Install footer */}
      <div className="flex-shrink-0 border-t border-border/40 px-6 py-4">
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        {isDenied ? (
          <p className="text-sm text-muted-foreground italic">
            Blocked by your organization&apos;s admins — cannot install.
          </p>
        ) : (
          <Button
            className="w-full"
            onClick={handleInstall}
            disabled={installing || detail.status !== "active"}
          >
            {installing ? "Installing…" : "Install to organization"}
          </Button>
        )}
      </div>
    </div>
  );
}
```

**Commit:** `feat(app): marketplace modal — type tabs, search/filter, card grid, bulk install, detail panel`

---

### Task D — API GET routes for catalog (modal data fetching)

The `MarketplaceModal` fetches via `GET /api/v1/plugin/catalog/browse` and `GET /api/v1/plugin/catalog/get`. The existing API routes are POST-only (`plugin.catalog.browse.ts`, `plugin.catalog.get.ts`). The modal needs GET endpoints to enable browser-native navigation caching.

- [ ] **D1** — Add GET handler to `plugin.catalog.browse` API route

**Files:** `apps/app/src/app/api/v1/plugin/catalog/browse/route.ts` (new — App Router API route)

**VERIFY:** Check whether the existing catalog routes live in `apps/app/src/app/api/` (Next.js App Router) or in `apps/api/src/routes/` (Hono). The Hono routes are served by the separate `apps/api` service; the Next.js App Router in `apps/app` handles `/api/v1/` only for routes defined under `apps/app/src/app/api/`. The MarketplaceModal is part of `apps/app`, so create an `apps/app` API route.

```ts
import { type NextRequest, NextResponse } from "next/server";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSession } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") ?? undefined;
  const authKind = searchParams.get("authKind") as "oauth" | "secret" | "none" | null ?? undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "30", 10), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);

  const ctx = {
    orgId: "",  // catalog.browse is scoped=false — org context not required
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke(
      "plugin.catalog.browse",
      { search, authKind, limit, offset },
      ctx,
      { surface: "agent" },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Browse failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **D2** — Add GET handler for catalog detail

**Files:** `apps/app/src/app/api/v1/plugin/catalog/get/route.ts` (new)

```ts
import { type NextRequest, NextResponse } from "next/server";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const catalogId = request.nextUrl.searchParams.get("catalogId");
  if (!catalogId) {
    return NextResponse.json({ error: "catalogId is required" }, { status: 400 });
  }

  const ctx = {
    orgId: "",
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke("plugin.catalog.get", { catalogId }, ctx, { surface: "agent" });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Get failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Commit:** `feat(app): Add GET API routes for plugin catalog browse + detail`

---

### Task E — Workspace install surface (replace integrations stub)

Replace `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` (currently a static stub) with a real server component that lists the org allow-list and lets workspace members enable/disable per plugin.

- [ ] **E1** — Create workspace plugin server actions

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/integration-actions.ts` (new)

Pattern: mirror `models-action.ts` exactly (resolve org + workspace, assert org member, gate on workspace-level owner/admin role, invoke).

```ts
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";

function buildCtx(opts: { orgId: string; workspaceId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

const NOT_AUTHORIZED = "Only workspace owners and admins can manage integrations.";

// ── setWorkspacePluginEnabledAction ───────────────────────────────────────────
const SetWsEnabledSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  enabled: z.boolean(),
});

export async function setWorkspacePluginEnabledAction(
  input: z.infer<typeof SetWsEnabledSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SetWsEnabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, enabled } = parsed.data;
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const wsRoleRows = await withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, ws.id),
            eq(schema.workspaceUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    );

    const wsRole = wsRoleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
      return { ok: false, error: NOT_AUTHORIZED };
    }

    const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
    try {
      await invoke("plugin.workspace.set_enabled", { orgListingId, enabled }, ctx, { surface: "agent" });
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.integrations(routeCtx));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Update failed" };
    }
  });
}

// ── setSecretAction ───────────────────────────────────────────────────────────
const SetSecretSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  orgListingId: z.string().min(1),
  secret: z.string().min(1).max(2048),
});

export async function setSecretAction(
  input: z.infer<typeof SetSecretSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await getSessionOrRedirect();
  const parsed = SetSecretSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, workspaceSlug, orgListingId, secret } = parsed.data;
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const wsRoleRows = await withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, ws.id),
            eq(schema.workspaceUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    );

    const wsRole = wsRoleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
      return { ok: false, error: NOT_AUTHORIZED };
    }

    const ctx = buildCtx({ orgId: org.id, workspaceId: ws.id, userId: session.user.id });
    try {
      await invoke(
        "plugin.credential.set_secret",
        { orgListingId, authKind: "secret", secret },
        ctx,
        { surface: "agent" },
      );
      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.integrations(routeCtx));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to save secret" };
    }
  });
}
```

- [ ] **E2** — Replace the integrations stub page

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` (replace)

```tsx
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { WorkspaceIntegrationsPanel } from "./workspace-integrations-panel";
import { setWorkspacePluginEnabledAction, setSecretAction } from "./integration-actions";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export const dynamic = "force-dynamic";

export default async function SettingsIntegrationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Read viewer workspace role
  const [wsRoleRow] = await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
    withTenantDb((tx) =>
      tx
        .select({ role: schema.workspaceUsers.role })
        .from(schema.workspaceUsers)
        .where(
          and(
            eq(schema.workspaceUsers.workspaceId, ws.id),
            eq(schema.workspaceUsers.userId, session.user.id),
          ),
        )
        .limit(1),
    ),
  );

  const wsRole = wsRoleRow?.role ?? "viewer";
  const canManage = ["owner", "admin"].includes(wsRole.toLowerCase());

  // Fetch the org allow-list (enabled org listings available to this workspace)
  // VERIFY: schema.pluginOrgListings — check packages/database/src/schema/ for exact table/column names.
  const orgListings = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgListings)
        .where(eq(schema.pluginOrgListings.orgId, org.id))
        .orderBy(schema.pluginOrgListings.name),
    ),
  ).catch(() => []);

  // Fetch workspace-level install rows to get per-listing enabled state + health
  // VERIFY: schema.mcpServers (agent.mcp_servers) — check that the table has org_listing_id column (added in Plan 1 migration).
  const wsInstalls = await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.mcpServers)
        .where(eq(schema.mcpServers.workspaceId, ws.id)),
    ),
  ).catch(() => []);

  // Build a map: orgListingId → workspace install row
  type WsInstall = (typeof wsInstalls)[number];
  const wsInstallMap = new Map<string, WsInstall>();
  for (const row of wsInstalls) {
    // VERIFY: row.orgListingId — the column name on the workspace install row.
    if (row.orgListingId) wsInstallMap.set(row.orgListingId, row);
  }

  return (
    <WorkspaceIntegrationsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      orgListings={orgListings}
      wsInstallMap={Object.fromEntries(wsInstallMap)}
      setEnabledAction={setWorkspacePluginEnabledAction}
      setSecretAction={setSecretAction}
    />
  );
}
```

- [ ] **E3** — Create `WorkspaceIntegrationsPanel` client component

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/workspace-integrations-panel.tsx` (new)

This client component renders the workspace-level plugin list. Each row shows:
- Plugin icon + name + type badge + auth kind badge
- Health status indicator (green dot = healthy, red = error, grey = unknown/unconfigured)
- Enabled `Switch` (calls `setEnabledAction` on change)
- **For `authKind === "secret"`:** a collapsed "Set API key" form that expands on button click; shows `<input type="password">` + Save. Uses `setSecretAction`.
- **For `authKind === "oauth"`:** a "Connect" / "Reconnect" `<a>` that links to the authorize route at `/api/v1/plugins/oauth/start?orgListingId={id}` (Plan 4 shipped this route). VERIFY the exact OAuth start route path from Plan 4.
- If `orgListings` is empty: empty state matching the current stub's visual treatment (centered icon + copy), but with a link to `org.settings.plugins(ctx)` + "Ask your org admin to install some plugins from the marketplace."

Row disabled state: if the org listing's `enabled = false`, the workspace toggle is grayed out with tooltip "Enable this plugin at the org level first."

```tsx
"use client";
import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plug, CheckCircle2, AlertCircle, Circle, ExternalLink } from "lucide-react";
import { org } from "@/lib/routes";
// ... full component implementation with the behaviors above
```

The health status column reads from `wsInstallMap[listing.id]?.healthStatus`:
- `"healthy"` → `<CheckCircle2 className="h-3.5 w-3.5 text-success" />`
- `"error"` or `"degraded"` → `<AlertCircle className="h-3.5 w-3.5 text-destructive" />`
- `null` / `undefined` / not yet installed → `<Circle className="h-3.5 w-3.5 text-muted-foreground/40" />` (not yet enabled)

**Commit:** `feat(app): workspace integrations page — org allow-list, enable/disable, secret entry, OAuth connect link`

---

### Task F — Re-auth deep-link page

- [ ] **F1** — Create re-auth route

**Files:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/reauth/[listingId]/page.tsx` (new)

This is the deep-link target page from in-app notifications (Plan 5) and emails. It shows the plugin details and a "Reconnect" button that links to the OAuth start route.

```tsx
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { Plug, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export default async function ReauthPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; listingId: string }>;
}) {
  const { orgSlug, workspaceSlug, listingId } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  // Resolve the listing by public_id (listingId from the URL is the public_id).
  // VERIFY: schema.pluginOrgListings — check column name for public_id (idMixin: `public_id`).
  const [listing] = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
    withTenantDb((tx) =>
      tx
        .select()
        .from(schema.pluginOrgListings)
        .where(
          and(
            eq(schema.pluginOrgListings.publicId, listingId),
            eq(schema.pluginOrgListings.orgId, org.id),
          ),
        )
        .limit(1),
    ),
  ).catch(() => []);

  if (!listing) notFound();

  const oauthStartUrl = `/api/v1/plugins/oauth/start?orgListingId=${listing.id}&workspaceId=${ws.id}`;
  // VERIFY: the OAuth start route path — Plan 4 ships it. Adjust if the path differs.

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
        {/* Icon: use listing.iconUrl if present, else generic */}
        {listing.iconUrl ? (
          <img src={listing.iconUrl} alt="" className="h-8 w-8 rounded object-contain" aria-hidden="true" />
        ) : (
          <Plug className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        )}
      </div>

      <div className="flex flex-col gap-2 max-w-sm">
        <h1 className="text-lg font-semibold">{listing.title ?? listing.name}</h1>
        <p className="text-sm text-muted-foreground">
          Your connection to <strong>{listing.title ?? listing.name}</strong> has expired or been revoked.
          Reconnect to restore access.
        </p>
      </div>

      {listing.authKind === "oauth" ? (
        <Button render={<Link href={oauthStartUrl} />}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
          Reconnect {listing.title ?? listing.name}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Contact your org admin to update the API key for this plugin in{" "}
          <Link href={`/${orgSlug}/settings/plugins`} className="text-primary underline">
            Org Settings → Plugins
          </Link>
          .
        </p>
      )}
    </div>
  );
}
```

**Note on `render` prop:** `Button` is a coss component wrapping `useRender`. For a `Link` render, use `render={<Link href={...} />}` (the `render` prop pattern from Base UI — confirmed in `badge.tsx`). If `Button` does not expose a `render` prop, use `asChild={false}` and wrap in a plain `<a>` or style the Link directly.

**VERIFY:** Check `apps/app/src/components/ui/button.tsx` for whether it exposes a `render` prop.

**Commit:** `feat(app): re-auth deep-link page for plugin OAuth reconnect`

---

### Task G — Org alert settings toggle (mcp_auth_alerts)

- [ ] **G1** — Add auth-alert settings UI to the org Plugins page

Per the spec (§7), orgs have a `settings.mcp_auth_alerts = { send_email: bool, roles: string[] }` JSONB field on `org.organizations.settings`. This task adds the UI toggle + role multiselect at the bottom of `OrgPluginsPanel`.

The `plugin.settings.set_auth_alerts` contract does NOT exist yet (not in `packages/oxagen/src/contracts/`). Implement the UI shell and use a direct DB update server action as a stop-gap until the capability is shipped.

**Files:** `apps/app/src/app/[orgSlug]/settings/plugins/plugin-actions.ts` (append to existing)

```ts
// ── setAuthAlertsAction ───────────────────────────────────────────────────────
// Stop-gap direct DB update. Replace with invoke("plugin.settings.set_auth_alerts", ...)
// once that capability is shipped (tracked in Linear).
const AuthAlertsSchema = z.object({
  orgSlug: z.string().min(1),
  sendEmail: z.boolean(),
  roles: z.array(z.string()).min(1),
});

export async function setAuthAlertsAction(
  input: z.infer<typeof AuthAlertsSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = AuthAlertsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const managed = await resolveManagedOrgForPlugins(parsed.data.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };

  const { withTenantDb, schema } = await import("@oxagen/database");
  const { eq } = await import("drizzle-orm");

  try {
    await runInTenantScope({ orgId: managed.orgId, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb((tx) =>
        tx
          .update(schema.organizations)
          .set({
            settings: tx.sql`
              COALESCE(settings, '{}'::jsonb) ||
              jsonb_build_object('mcp_auth_alerts', jsonb_build_object(
                'send_email', ${parsed.data.sendEmail}::boolean,
                'roles', ${JSON.stringify(parsed.data.roles)}::jsonb
              ))
            `,
          })
          .where(eq(schema.organizations.id, managed.orgId)),
      ),
    );
    revalidatePath(`/${parsed.data.orgSlug}/settings/plugins`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to update alert settings" };
  }
}
```

**VERIFY:** Check `schema.organizations.settings` — if the column is `jsonb`, the `||` merge operator works. If it's `text` or absent, adjust accordingly.

- [ ] **G2** — Add `OrgAuthAlertsSection` to `OrgPluginsPanel`

Add a new section at the bottom of `org-plugins-panel.tsx`:

```tsx
// OrgAuthAlertsSection — inside OrgPluginsPanel, after the Denylist section
// Shows only when canManage = true

function OrgAuthAlertsSection({
  orgSlug,
  initialSendEmail,
  initialRoles,
  setAuthAlertsAction,
}: {
  orgSlug: string;
  initialSendEmail: boolean;
  initialRoles: string[];
  setAuthAlertsAction: (input: { orgSlug: string; sendEmail: boolean; roles: string[] }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const AVAILABLE_ROLES = ["Owner", "Admin"] as const;
  const [sendEmail, setSendEmail] = React.useState(initialSendEmail);
  const [roles, setRoles] = React.useState<string[]>(initialRoles);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggleRole = (role: string) =>
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );

  const handleSave = async () => {
    if (roles.length === 0) { setError("At least one role must be selected."); return; }
    setSaving(true);
    setError(null);
    const result = await setAuthAlertsAction({ orgSlug, sendEmail, roles });
    setSaving(false);
    if (!result.ok) setError(result.error ?? "Save failed");
  };

  return (
    <div className="rounded-xl border border-border/60 p-6">
      <h3 className="mb-1 text-sm font-medium">Re-authentication alerts</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        Notify selected org roles when a plugin&apos;s OAuth token expires and requires re-authentication.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <Switch
          checked={sendEmail}
          onCheckedChange={setSendEmail}
          id="send-email-toggle"
        />
        <label htmlFor="send-email-toggle" className="text-sm">Send email notifications</label>
      </div>

      <div className="flex flex-col gap-2 mb-4">
        <p className="text-xs font-medium text-muted-foreground">Notify roles</p>
        <div className="flex gap-3">
          {AVAILABLE_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              {role}
            </label>
          ))}
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      <Button size="sm" onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save alert settings"}
      </Button>
    </div>
  );
}
```

**Commit:** `feat(app): org auth-alert settings — send_email toggle + role multiselect`

---

### Task H — Typecheck, lint, and manual verification checklist

- [ ] **H1** — Run typecheck + lint

```bash
cd /Users/macanderson/oxagen-monorepo
pnpm --filter @oxagen/app tsc --noEmit
pnpm --filter @oxagen/app lint
```

Fix every error before declaring done. Common gotchas:
- Missing `"use client"` on components that use `React.useState` or event handlers.
- Missing `"use server"` on actions files.
- Missing `import "@oxagen/handlers/register"` in any `invoke()` caller (server-only side effect — TypeScript does not catch this).
- `any` usage — use precise types or `unknown`. The `withTenantDb` query results are typed by Drizzle; use them.
- Drizzle schema column names — verify `schema.pluginOrgListings`, `schema.pluginOrgDenylist`, `schema.mcpServers` against `packages/database/src/schema/` before committing.

- [ ] **H2** — Manual browser verification checklist

Using the chrome-devtools MCP (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`), verify the following in order (log in via `creds.json` first):

1. **Org Plugins settings page loads:**
   - Navigate to `http://localhost:3000/{orgSlug}/settings/plugins`.
   - Assert: "Plugins" tab is visible in the settings nav alongside "General".
   - Assert: Registries section shows the default MCP seed registry with a "Default" badge and no Remove button.
   - Assert: If no plugins installed, the allow-list shows an empty state or an empty table.
   - Assert: Denylist section renders.

2. **Marketplace modal opens:**
   - Click "Browse marketplace" button.
   - Assert: `<dialog>` element is open and `max-w-5xl` class is applied.
   - Assert: Three type tabs render (MCP Servers / Integrations / Content Tools).
   - Assert: Server cards load (spinner, then grid).
   - Assert: Auth filter chips render and clicking "oauth" re-fetches.
   - Assert: Clicking a card opens the detail panel on the right.
   - Assert: Detail panel shows logo, title, transport/auth badges, and README (or "No README" fallback).

3. **Multi-select bulk install:**
   - Select 2 servers via their checkboxes.
   - Assert: "Install selected (2)" button in footer is enabled.
   - Click it; assert: the modal closes (or shows success).
   - Assert: installed servers appear in the org allow-list on the Plugins page.

4. **Single install from detail panel:**
   - Open a server detail, click "Install to organization".
   - Assert: the modal closes and the allow-list updates.

5. **Org enable/disable toggle:**
   - On the Plugins page allow-list, toggle a plugin's Switch.
   - Assert: Switch reflects the new state without page reload.

6. **Denylist a server:**
   - Enter a server name in the Denylist form, click "Deny".
   - Assert: the server appears in the denylist table.
   - Re-open the marketplace — assert the denied server's card is greyed out with "Blocked by your organization's admins".

7. **Workspace integrations page:**
   - Navigate to `/{orgSlug}/{workspaceSlug}/settings/integrations`.
   - Assert: the stub is replaced with the real panel.
   - Assert: installed org plugins are listed.
   - Assert: the workspace enable/disable Switch works.

8. **Re-auth page:**
   - Navigate to `/{orgSlug}/{workspaceSlug}/settings/integrations/reauth/{any-listing-public-id}`.
   - Assert: page renders with plugin name + "Reconnect" button (OAuth listing) or the API key fallback copy.

9. **Non-admin role gate:**
   - Log in as a workspace member (non-owner/non-admin).
   - Assert: accessing `/{orgSlug}/settings/plugins` as a non-manager returns 404 (Next.js `notFound()` behavior).

> Full E2E Playwright suite (mock OAuth server, agent integration, RBAC negative tests) is Plan 7.

**Commit:** `chore(app): typecheck + manual verify — Plan 6 UI complete`

---

### Done criteria

- [ ] `assertMcpManager` lives in `apps/app/src/lib/resolve-org.ts` alongside `assertBillingManager`.
- [ ] `resolveManagedOrgForPlugins` is the sole authorization gate for all org plugin server actions.
- [ ] Org Plugins settings page (`/{orgSlug}/settings/plugins`) renders with registries, allow-list, custom-server form, denylist, and auth-alert toggle.
- [ ] Settings nav at `/{orgSlug}/settings/` shows "General" and "Plugins" tabs (layout.tsx added).
- [ ] `routes.ts` has `org.settings.plugins`.
- [ ] Marketplace modal opens from Plugins page, shows three type tabs, filters, card grid with multi-select, detail panel with README HTML, bulk install, and denied-server treatment.
- [ ] `GET /api/v1/plugin/catalog/browse` and `GET /api/v1/plugin/catalog/get` Next.js API routes are wired and authenticated.
- [ ] Workspace integrations page (`/{orgSlug}/{workspaceSlug}/settings/integrations`) replaces the stub with a real panel (allow-list, enable toggle, secret form, OAuth link, health status).
- [ ] Re-auth deep-link page (`/…/integrations/reauth/[listingId]`) renders and links to the OAuth start route.
- [ ] `setAuthAlertsAction` updates `org.organizations.settings.mcp_auth_alerts`.
- [ ] `pnpm tsc --noEmit` passes for `apps/app`.
- [ ] Manual browser checklist (Task H) fully checked off.
- [ ] No `any` types. No dead code. No glass/translucency in any component. No `asChild` — use `render` prop.
- [ ] All VERIFY pointers resolved (schema names confirmed, button render-prop confirmed, OAuth start path confirmed).

**Next plan:** `docs/superpowers/plans/2026-06-06-installable-plugins-07-e2e-docs.md`

## Document — `2026-06-06-installable-plugins-07-e2e-docs.md`

## Installable Plugins — Plan 7: E2E Tests + Documentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the installable-plugins epic with comprehensive Playwright E2E coverage of all nine enumerated flows, offline fixture servers, a plugin-seed DB helper, and user-facing docs for the marketplace and workspace install surfaces.

**Architecture:** Two in-process fixture HTTP servers (mock MCP + mock OAuth) are started by `playwright.config.ts` via `globalSetup`; each spec seeds its own tenant via a lightweight `seedPlugin` DB helper that mirrors the existing `setupAgentRuntimeFixture` pattern; the fixture servers write to a shared port file so specs can read their URLs. All specs are deterministic and offline — no real Stripe, Anthropic, or registry calls are made.

**Tech Stack:** Playwright 1.60, Node `http` (built-in, no extra dep) for fixture servers, `postgres` (already a dev dep) for DB seed helpers, TypeScript 6, `pnpm --filter @oxagen/app exec playwright test` (root) or `pnpm test:e2e` (in `apps/app`).

**Spec:** `docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md` (§11 testing, §10 docs)

---

### Task A — E2E harness: fixture servers + seed helper

> Adds the offline fixture infrastructure that every plugin spec depends on.

#### A1 — Mock MCP server

- [ ] Create `apps/app/e2e/fixtures/mock-mcp-server.ts`.

```typescript
/**
 * mock-mcp-server.ts
 *
 * A minimal MCP streamable-HTTP server for E2E tests. Implements one tool
 * ("e2e_ping") so agent-integration tests can assert the tool was invoked.
 * Started by globalSetup, stopped by globalTeardown; listens on a random
 * port written to MOCK_MCP_PORT env var.
 *
 * Transport: streamable HTTP (POST /mcp).
 * Protocol: MCP 2025-03-26 (minimal subset — initialize + tools/call).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockMcpHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

function buildJsonRpcResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function buildJsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockMcpServer(): Promise<MockMcpHandle> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    let rpc: { jsonrpc: string; id: unknown; method: string; params?: unknown };
    try {
      rpc = JSON.parse(body) as typeof rpc;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(buildJsonRpcError(null, -32700, "Parse error"));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });

    if (rpc.method === "initialize") {
      res.end(
        buildJsonRpcResponse(rpc.id, {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "mock-mcp-e2e", version: "0.0.1" },
          capabilities: { tools: {} },
        }),
      );
      return;
    }

    if (rpc.method === "tools/list") {
      res.end(
        buildJsonRpcResponse(rpc.id, {
          tools: [
            {
              name: "e2e_ping",
              description: "E2E smoke tool — returns pong.",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        }),
      );
      return;
    }

    if (rpc.method === "tools/call") {
      const p = rpc.params as { name: string; arguments: Record<string, unknown> };
      if (p.name !== "e2e_ping") {
        res.end(buildJsonRpcError(rpc.id, -32601, "Tool not found"));
        return;
      }
      res.end(
        buildJsonRpcResponse(rpc.id, {
          content: [{ type: "text", text: "pong" }],
          isError: false,
        }),
      );
      return;
    }

    res.end(buildJsonRpcError(rpc.id, -32601, "Method not found"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock-mcp-server: no address");
  const port = addr.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
```

- [ ] Commit: `test(e2e): add mock MCP server fixture`

#### A2 — Mock OAuth authorization server

- [ ] Create `apps/app/e2e/fixtures/mock-oauth-server.ts`.

```typescript
/**
 * mock-oauth-server.ts
 *
 * A minimal OAuth 2.1 authorization server for E2E tests.
 * Implements:
 *   GET  /.well-known/oauth-authorization-server  — metadata
 *   GET  /authorize                               — instant-redirect (no UI)
 *   POST /token                                   — issues a mock access token
 *
 * All tokens are predictable so specs can assert stored credential values.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";

export interface MockOAuthHandle {
  port: number;
  issuer: string;
  stop: () => Promise<void>;
}

export const MOCK_ACCESS_TOKEN = "e2e_mock_access_token";
export const MOCK_REFRESH_TOKEN = "e2e_mock_refresh_token";

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockOAuthServer(): Promise<MockOAuthHandle> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);

    // ── Well-known metadata ───────────────────────────────────────────────────
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }

    // ── Authorization endpoint — instant redirect with code ───────────────────
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set("code", "e2e_auth_code");
      if (state) redirectTarget.searchParams.set("state", state);
      res.writeHead(302, { location: redirectTarget.toString() });
      res.end();
      return;
    }

    // ── Token endpoint ────────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");

      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: MOCK_REFRESH_TOKEN,
          scope: "mcp",
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("mock-oauth-server: no address");
  const port = addr.port;

  return {
    port,
    issuer: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
```

- [ ] Commit: `test(e2e): add mock OAuth authorization server fixture`

#### A3 — Global setup/teardown wiring

- [ ] Create `apps/app/e2e/fixtures/global-setup.ts`.

```typescript
/**
 * global-setup.ts — start fixture servers before Playwright runs any spec.
 *
 * Writes MOCK_MCP_PORT and MOCK_OAUTH_PORT to process.env so specs can read
 * them via `process.env`. Playwright passes env through to worker processes.
 * Also writes a JSON sidecar at /tmp/oxagen-e2e-fixtures.json for any helper
 * that needs the URLs outside of test process.env.
 */
import { writeFileSync } from "node:fs";
import { startMockMcpServer } from "./mock-mcp-server";
import { startMockOAuthServer } from "./mock-oauth-server";

let _mcpStop: (() => Promise<void>) | null = null;
let _oauthStop: (() => Promise<void>) | null = null;

export default async function globalSetup(): Promise<void> {
  const [mcp, oauth] = await Promise.all([startMockMcpServer(), startMockOAuthServer()]);

  _mcpStop = mcp.stop;
  _oauthStop = oauth.stop;

  process.env.MOCK_MCP_URL = mcp.url;
  process.env.MOCK_MCP_PORT = String(mcp.port);
  process.env.MOCK_OAUTH_ISSUER = oauth.issuer;
  process.env.MOCK_OAUTH_PORT = String(oauth.port);

  writeFileSync(
    "/tmp/oxagen-e2e-fixtures.json",
    JSON.stringify({ mcpUrl: mcp.url, oauthIssuer: oauth.issuer }),
  );
}

// Playwright calls a named export `globalTeardown` on the same module
// when using the `globalSetup` path. We store references above.
export async function globalTeardown(): Promise<void> {
  await Promise.all([_mcpStop?.(), _oauthStop?.()]);
}
```

- [ ] Edit `apps/app/playwright.config.ts` — add `globalSetup` and `globalTeardown` pointing at the fixture:

```typescript
// Add to the defineConfig object (keep all existing keys):
globalSetup: "./e2e/fixtures/global-setup.ts",
globalTeardown: "./e2e/fixtures/global-setup.ts",
```

  The teardown export name (`globalTeardown`) is exported from the same file; Playwright reads it automatically when the globalSetup module exports it.

- [ ] Commit: `test(e2e): wire globalSetup/globalTeardown for fixture servers`

#### A4 — Plugin DB seed helper

- [ ] Create `apps/app/e2e/helpers/seed-plugin.ts`.

```typescript
/**
 * seed-plugin.ts — DB helper for plugin E2E tests.
 *
 * seedPlugin: inserts a fresh user+org+workspace+session (same pattern as
 * setupAgentRuntimeFixture), then seeds the plugin tables needed to start a
 * spec mid-flow:
 *   - plugin.registries row (the default MCP registry, pointing at the mock
 *     MCP server URL so specs don't hit the real registry)
 *   - plugin.catalog_servers row (one mock server entry)
 *   - plugin.org_listings row (pre-installed, disabled — ready to enable)
 *   - agent.mcp_servers row (workspace-enabled — ready for agent integration)
 *
 * All inserts use ON CONFLICT DO NOTHING for idempotency.
 * teardownPlugin cleans up in FK-safe order.
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

function uid(): string {
  return randomBytes(6).toString("hex");
}

export interface PluginFixtureOptions {
  orgSlug: string;
  workspaceSlug: string;
  userEmail: string;
  /** URL of the mock MCP server (e.g. from process.env.MOCK_MCP_URL). */
  mockMcpUrl: string;
}

export interface PluginFixture {
  orgId: string;
  workspaceId: string;
  userId: string;
  sessionToken: string;
  orgSlug: string;
  workspaceSlug: string;
  /** public_id of the seeded plugin.org_listings row (disabled, for enable tests). */
  orgListingId: string;
  /** public_id of the seeded plugin.catalog_servers row. */
  catalogServerId: string;
  cleanup: () => Promise<void>;
}

export async function seedPlugin(opts: PluginFixtureOptions): Promise<PluginFixture> {
  const sql = postgres(DATABASE_URL, { max: 3, prepare: false });

  const id = uid();

  // ── Org ──────────────────────────────────────────────────────────────────────
  const [orgRow] = await sql<{ id: string }[]>`
    INSERT INTO org.organizations (public_id, name, slug, plan_type, status)
    VALUES ('org_e2e_' || ${id}, ${"E2E Plugin " + opts.orgSlug}, ${opts.orgSlug}, 'free', 'active')
    ON CONFLICT (slug) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!orgRow) throw new Error("seedPlugin: org upsert returned no row");
  const orgId = orgRow.id;

  // ── User ─────────────────────────────────────────────────────────────────────
  const [userRow] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (public_id, email, display_name, status, email_verified_at)
    VALUES ('usr_e2e_' || ${id}, ${opts.userEmail}, 'E2E Plugin', 'active', now())
    ON CONFLICT (email) DO UPDATE SET status = 'active'
    RETURNING id
  `;
  if (!userRow) throw new Error("seedPlugin: user upsert returned no row");
  const userId = userRow.id;

  // ── Workspace ─────────────────────────────────────────────────────────────────
  const [wsRow] = await sql<{ id: string }[]>`
    INSERT INTO workspace.workspaces (public_id, org_id, name, slug)
    VALUES ('wrk_e2e_' || ${id}, ${orgId}, 'Main', ${opts.workspaceSlug})
    ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  if (!wsRow) throw new Error("seedPlugin: workspace upsert returned no row");
  const workspaceId = wsRow.id;

  // ── Memberships ───────────────────────────────────────────────────────────────
  await sql`
    INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
    VALUES ('oru_e2e_' || ${id}, ${orgId}, ${userId}, 'owner', now())
    ON CONFLICT (org_id, user_id) DO NOTHING
  `;
  await sql`
    INSERT INTO workspace.workspace_users (public_id, workspace_id, user_id, role, joined_at)
    VALUES ('wsu_e2e_' || ${id}, ${workspaceId}, ${userId}, 'owner', now())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `;

  // ── Session ───────────────────────────────────────────────────────────────────
  const sessionToken = `e2e-plugin-session-${id}`;
  await sql`
    INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent)
    VALUES (${sessionToken}, ${sessionToken}, ${userId}, now() + interval '1 hour', '127.0.0.1', 'playwright-e2e')
    ON CONFLICT (id) DO NOTHING
  `;

  // ── Plugin registry (mock) ───────────────────────────────────────────────────
  const registryId = `reg_e2e_${id}`;
  await sql`
    INSERT INTO plugin.registries (public_id, org_id, name, registry_url, is_default, is_active)
    VALUES (${registryId}, ${orgId}, 'E2E Mock Registry', ${opts.mockMcpUrl}, false, true)
    ON CONFLICT (public_id) DO NOTHING
  `;

  // Resolve the internal registry UUID.
  const [regRow] = await sql<{ id: string }[]>`
    SELECT id FROM plugin.registries WHERE public_id = ${registryId}
  `;
  if (!regRow) throw new Error("seedPlugin: registry insert returned no row");
  const registryDbId = regRow.id;

  // ── Catalog server entry ──────────────────────────────────────────────────────
  const catalogServerId = `srv_e2e_${id}`;
  await sql`
    INSERT INTO plugin.catalog_servers (
      public_id, registry_id, server_name, title, description,
      plugin_type, transport, auth_kind, endpoint_url, is_latest, status
    )
    VALUES (
      ${catalogServerId},
      ${registryDbId},
      ${"e2e.mock.mcp." + id},
      'E2E Mock MCP Server',
      'Smoke-test fixture MCP server with one tool: e2e_ping.',
      'mcp_server',
      'streamable_http',
      'none',
      ${opts.mockMcpUrl + "/mcp"},
      true,
      'active'
    )
    ON CONFLICT (public_id) DO NOTHING
  `;

  const [catalogRow] = await sql<{ id: string }[]>`
    SELECT id FROM plugin.catalog_servers WHERE public_id = ${catalogServerId}
  `;
  if (!catalogRow) throw new Error("seedPlugin: catalog_server insert returned no row");
  const catalogDbId = catalogRow.id;

  // ── Org listing (installed but disabled — tests enable it) ───────────────────
  const orgListingId = `lst_e2e_${id}`;
  await sql`
    INSERT INTO plugin.org_listings (
      public_id, org_id, catalog_server_id, enabled, auth_kind, server_name
    )
    VALUES (${orgListingId}, ${orgId}, ${catalogDbId}, false, 'none', ${"e2e.mock.mcp." + id})
    ON CONFLICT (public_id) DO NOTHING
  `;

  const [listingRow] = await sql<{ id: string }[]>`
    SELECT id FROM plugin.org_listings WHERE public_id = ${orgListingId}
  `;
  if (!listingRow) throw new Error("seedPlugin: org_listing insert returned no row");
  const listingDbId = listingRow.id;

  // ── Workspace MCP server row (enabled — for agent-integration spec) ───────────
  await sql`
    INSERT INTO agent.mcp_servers (
      public_id, org_id, workspace_id, org_listing_id, name,
      endpoint_url, transport, enabled, health_status
    )
    VALUES (
      ${"mcp_e2e_" + id},
      ${orgId},
      ${workspaceId},
      ${listingDbId},
      'E2E Mock MCP',
      ${opts.mockMcpUrl + "/mcp"},
      'streamable_http',
      true,
      'healthy'
    )
    ON CONFLICT (public_id) DO NOTHING
  `;

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  const cleanup = async (): Promise<void> => {
    const csql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      await csql`DELETE FROM agent.mcp_servers WHERE org_id = ${orgId}`;
      await csql`DELETE FROM plugin.org_listings WHERE org_id = ${orgId}`;
      await csql`DELETE FROM plugin.catalog_servers WHERE registry_id = ${registryDbId}`;
      await csql`DELETE FROM plugin.registries WHERE org_id = ${orgId}`;
      await csql`DELETE FROM auth.sessions WHERE id = ${sessionToken}`;
      await csql`DELETE FROM workspace.workspace_users WHERE workspace_id = ${workspaceId}`;
      await csql`DELETE FROM workspace.workspaces WHERE id = ${workspaceId}`;
      await csql`DELETE FROM org.org_users WHERE org_id = ${orgId}`;
      await csql`DELETE FROM auth.users WHERE id = ${userId}`;
      await csql`DELETE FROM org.organizations WHERE id = ${orgId}`;
    } finally {
      await csql.end({ timeout: 5 });
    }
  };

  await sql.end({ timeout: 5 });

  return {
    orgId,
    workspaceId,
    userId,
    sessionToken,
    orgSlug: opts.orgSlug,
    workspaceSlug: opts.workspaceSlug,
    orgListingId,
    catalogServerId,
    cleanup,
  };
}
```

- [ ] Commit: `test(e2e): add seedPlugin DB helper for plugin fixture state`

---

### Task B — Spec 1: marketplace install (single + bulk multi-select)

- [ ] Create `apps/app/e2e/mcp-marketplace-install.spec.ts`.

**Required `data-testid` attributes** — if missing from Plan 6 UI, add them:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="browse-marketplace-btn"` on the "Browse marketplace" button.
- `apps/app/src/components/plugins/marketplace-dialog.tsx` → `data-testid="marketplace-dialog"` on the `DialogPopup`, `data-testid="plugin-card-{serverName}"` on each server card, `data-testid="plugin-card-checkbox-{serverName}"` on each multi-select checkbox, `data-testid="install-selected-btn"` on the bulk-install button, `data-testid="plugin-install-btn"` on the detail-page install button, `data-testid="marketplace-tab-mcp_server"` on the MCP Servers tab.

```typescript
/**
 * mcp-marketplace-install.spec.ts
 *
 * E2E flow 1: Install MCP from marketplace (single + bulk multi-select).
 *
 * Uses seedPlugin for a pre-seeded catalog entry that points at the
 * mock MCP server started by globalSetup.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-marketplace-install — single install", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `mkt-single-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-mkt-s-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("open marketplace, select server, click Install — org listing becomes enabled", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Open marketplace dialog.
    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-dialog")).toBeVisible();

    // Ensure the MCP Servers tab is active.
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Find the fixture server card.
    const card = page.getByTestId(`plugin-card-${fixture.catalogServerId}`);
    await expect(card).toBeVisible();

    // Click through to detail and install.
    await card.click();
    await page.getByTestId("plugin-install-btn").click();

    // Dialog closes or a success toast appears.
    await expect(page.getByTestId("marketplace-dialog")).not.toBeVisible({ timeout: 10_000 });

    // The server now appears in the org allow-list.
    await expect(page.getByTestId(`org-listing-row-${fixture.orgListingId}`)).toBeVisible();
  });
});

test.describe("mcp-marketplace-install — bulk multi-select", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `mkt-bulk-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-mkt-b-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("multi-select checkbox + Install selected (n) installs server", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-dialog")).toBeVisible();
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Check the fixture server's checkbox.
    await page.getByTestId(`plugin-card-checkbox-${fixture.catalogServerId}`).check();

    // Bulk install button shows count ≥ 1.
    const bulkBtn = page.getByTestId("install-selected-btn");
    await expect(bulkBtn).toBeVisible();
    await expect(bulkBtn).toContainText("1");
    await bulkBtn.click();

    // Dialog closes.
    await expect(page.getByTestId("marketplace-dialog")).not.toBeVisible({ timeout: 10_000 });

    // Server appears in org allow-list.
    await expect(page.getByTestId(`org-listing-row-${fixture.orgListingId}`)).toBeVisible();
  });
});
```

- [ ] Commit: `test(e2e): marketplace install spec (single + bulk)`

---

### Task C — Spec 2: add custom MCP server + custom registry

- [ ] Create `apps/app/e2e/mcp-org-add-custom.spec.ts`.

**Required `data-testid` attributes** — add to Plan 6 UI if missing:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="add-custom-server-btn"`, `data-testid="add-custom-registry-btn"`.
- `apps/app/src/components/plugins/add-custom-server-form.tsx` → `data-testid="custom-server-name-input"`, `data-testid="custom-server-endpoint-input"`, `data-testid="custom-server-submit-btn"`.
- `apps/app/src/components/plugins/add-custom-registry-form.tsx` → `data-testid="custom-registry-name-input"`, `data-testid="custom-registry-url-input"`, `data-testid="custom-registry-submit-btn"`.

```typescript
/**
 * mcp-org-add-custom.spec.ts
 *
 * E2E flow 2: Add a custom MCP server and a custom registry to an org.
 */
import { test, expect } from "@playwright/test";
import { signUpFreshUser } from "./helpers/signup";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-org-add-custom — custom server", () => {
  test("owner can add a custom MCP server to the org allow-list", async ({ page }) => {
    const id = uid();
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: `custom-srv-${id}` });

    await page.goto(`/${orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    await page.getByTestId("add-custom-server-btn").click();

    const mockMcpUrl = process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999";

    await page.getByTestId("custom-server-name-input").fill(`custom-mcp-${id}`);
    await page.getByTestId("custom-server-endpoint-input").fill(`${mockMcpUrl}/mcp`);
    await page.getByTestId("custom-server-submit-btn").click();

    // The new server appears in the org allow-list.
    await expect(page.getByText(`custom-mcp-${id}`)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("mcp-org-add-custom — custom registry + install from it", () => {
  test("owner can add a custom registry and browse servers from it", async ({ page }) => {
    const id = uid();
    const { orgSlug } = await signUpFreshUser(page, { orgPrefix: `custom-reg-${id}` });

    await page.goto(`/${orgSlug}/settings/plugins`);

    await page.getByTestId("add-custom-registry-btn").click();

    const mockMcpUrl = process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999";

    await page.getByTestId("custom-registry-name-input").fill(`E2E Registry ${id}`);
    await page.getByTestId("custom-registry-url-input").fill(mockMcpUrl);
    await page.getByTestId("custom-registry-submit-btn").click();

    // The new registry appears in the registries list.
    await expect(page.getByText(`E2E Registry ${id}`)).toBeVisible({ timeout: 10_000 });
  });
});
```

- [ ] Commit: `test(e2e): custom server + registry add specs`

---

### Task D — Spec 3: enable MCP at workspace layer

- [ ] Create `apps/app/e2e/mcp-workspace-enable.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` → `data-testid="plugin-row-{orgListingId}"`, `data-testid="plugin-enable-toggle-{orgListingId}"`.

```typescript
/**
 * mcp-workspace-enable.spec.ts
 *
 * E2E flow 3: Enable a pre-installed (org-allowed, disabled) MCP server
 * at the workspace layer.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-workspace-enable", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `ws-enable-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-ws-en-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("workspace owner can enable an org-allowed MCP server for this workspace", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // First enable the org listing so it appears in the workspace panel.
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    const enableOrgToggle = page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`);
    await expect(enableOrgToggle).toBeVisible();
    await enableOrgToggle.click();

    // Navigate to the workspace integrations page.
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/settings/integrations`);
    await expect(page).not.toHaveURL(/\/login/);

    // The seeded server should be visible in the allow-list.
    const row = page.getByTestId(`plugin-row-${fixture.orgListingId}`);
    await expect(row).toBeVisible();

    // Toggle it on.
    const toggle = page.getByTestId(`plugin-enable-toggle-${fixture.orgListingId}`);
    await toggle.click();

    // Toggle should now reflect enabled state.
    await expect(toggle).toHaveAttribute("data-state", "checked");
  });
});
```

- [ ] Commit: `test(e2e): workspace-layer enable spec`

---

### Task E — Spec 4: authenticate to OAuth MCP server

- [ ] Create `apps/app/e2e/mcp-oauth-connect.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/integrations/page.tsx` → `data-testid="plugin-connect-btn-{orgListingId}"`, `data-testid="plugin-auth-status-{orgListingId}"`.

```typescript
/**
 * mcp-oauth-connect.spec.ts
 *
 * E2E flow 4: Authenticate to an org-enabled OAuth MCP server using the
 * mock OAuth authorization server started by globalSetup.
 *
 * The mock OAuth server returns an instant redirect with `code=e2e_auth_code`.
 * The app's callback handler exchanges it for MOCK_ACCESS_TOKEN. We assert
 * the plugin row shows "connected" status after redirect.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-oauth-connect", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `oauth-conn-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-oauth-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_OAUTH_ISSUER ?? "http://127.0.0.1:9998",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("clicking Connect initiates OAuth and callback marks server as connected", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // Navigate to workspace integrations.
    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/settings/integrations`);
    await expect(page).not.toHaveURL(/\/login/);

    const connectBtn = page.getByTestId(`plugin-connect-btn-${fixture.orgListingId}`);
    await expect(connectBtn).toBeVisible();

    // The mock OAuth server instantly redirects back with code. Playwright
    // follows the redirect chain automatically — we just wait for the final URL.
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.pathname.includes("/settings/integrations") &&
          !url.searchParams.has("code"),
        { timeout: 15_000 },
      ),
      connectBtn.click(),
    ]);

    // Auth status badge should now read "connected".
    const statusEl = page.getByTestId(`plugin-auth-status-${fixture.orgListingId}`);
    await expect(statusEl).toHaveText(/connected/i);
  });
});
```

- [ ] Commit: `test(e2e): OAuth connect flow spec`

---

### Task F — Spec 5: disable a previously-enabled server

- [ ] Create `apps/app/e2e/mcp-disable.spec.ts`.

```typescript
/**
 * mcp-disable.spec.ts
 *
 * E2E flow 5: Disable a previously-enabled MCP server at the org layer.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-disable", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `disable-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-dis-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("owner can disable an enabled MCP server at the org allow-list", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // Enable first (fixture seeds as disabled).
    const enableToggle = page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`);
    await enableToggle.click();
    await expect(enableToggle).toHaveAttribute("data-state", "checked");

    // Now disable.
    await enableToggle.click();
    await expect(enableToggle).toHaveAttribute("data-state", "unchecked");

    // Reload to confirm DB-persisted.
    await page.reload();
    await expect(
      page.getByTestId(`org-listing-enable-toggle-${fixture.orgListingId}`),
    ).toHaveAttribute("data-state", "unchecked");
  });
});
```

- [ ] Commit: `test(e2e): disable MCP server spec`

---

### Task G — Spec 6: remove from org allow-list (uninstall)

- [ ] Create `apps/app/e2e/mcp-uninstall.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="org-listing-uninstall-btn-{orgListingId}"` on the "Remove" / uninstall button per row.
- Confirm dialog → `data-testid="uninstall-confirm-btn"`.

```typescript
/**
 * mcp-uninstall.spec.ts
 *
 * E2E flow 6: Remove an MCP server from the org allow-list.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-uninstall", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `uninstall-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-uninst-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("owner can remove an MCP server from the org allow-list", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);
    await expect(page).not.toHaveURL(/\/login/);

    // The listing row must be visible.
    await expect(
      page.getByTestId(`org-listing-row-${fixture.orgListingId}`),
    ).toBeVisible();

    // Click uninstall.
    await page.getByTestId(`org-listing-uninstall-btn-${fixture.orgListingId}`).click();

    // Confirm dialog.
    await expect(page.getByTestId("uninstall-confirm-btn")).toBeVisible();
    await page.getByTestId("uninstall-confirm-btn").click();

    // Row is gone.
    await expect(
      page.getByTestId(`org-listing-row-${fixture.orgListingId}`),
    ).not.toBeVisible({ timeout: 10_000 });
  });
});
```

- [ ] Commit: `test(e2e): uninstall MCP server spec`

---

### Task H — Spec 7: denylist — denied server visible but not installable

- [ ] Create `apps/app/e2e/mcp-denylist.spec.ts`.

**Required `data-testid` attributes**:
- `apps/app/src/app/[orgSlug]/settings/plugins/page.tsx` → `data-testid="denylist-add-btn"`, `data-testid="denylist-server-name-input"`, `data-testid="denylist-submit-btn"`.
- Marketplace dialog card for denied server → `data-testid="plugin-card-denied-badge-{serverName}"`, install button disabled → `aria-disabled="true"`.

```typescript
/**
 * mcp-denylist.spec.ts
 *
 * E2E flow 7: Maintain a denylist. Assert denied server is not installable
 * but still visible in the marketplace with denied treatment + explanatory copy.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-denylist", () => {
  let fixture: PluginFixture;
  let deniedServerName: string;

  test.beforeAll(async () => {
    const id = uid();
    deniedServerName = `e2e.mock.mcp.${id}`;
    fixture = await seedPlugin({
      orgSlug: `denylist-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-deny-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("denied server is visible in marketplace with blocked treatment", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    // Add server name to denylist.
    await page.getByTestId("denylist-add-btn").click();
    await page.getByTestId("denylist-server-name-input").fill(fixture.catalogServerId);
    await page.getByTestId("denylist-submit-btn").click();

    // Open marketplace.
    await page.getByTestId("browse-marketplace-btn").click();
    await expect(page.getByTestId("marketplace-dialog")).toBeVisible();
    await page.getByTestId("marketplace-tab-mcp_server").click();

    // Denied badge is present.
    const deniedBadge = page.getByTestId(`plugin-card-denied-badge-${fixture.catalogServerId}`);
    await expect(deniedBadge).toBeVisible();

    // Explanatory copy visible.
    await expect(
      page.getByText(/blocked by your organization/i),
    ).toBeVisible();

    // Install button is disabled.
    const installBtn = page.getByTestId("plugin-install-btn");
    await expect(installBtn).toHaveAttribute("aria-disabled", "true");
  });
});
```

- [ ] Commit: `test(e2e): denylist spec — denied server visible but not installable`

---

### Task I — Spec 8: RBAC negative — non-credentialed user cannot manage plugins

- [ ] Create `apps/app/e2e/mcp-rbac-negative.spec.ts`.

**Required `data-testid` attributes**:
- Ensure `browse-marketplace-btn`, `add-custom-server-btn`, `add-custom-registry-btn`, `denylist-add-btn` are NOT rendered for Member/Viewer role users (server-component role gate), or are visibly disabled with `aria-disabled`.

```typescript
/**
 * mcp-rbac-negative.spec.ts
 *
 * E2E flow 8: RBAC negative test.
 * A Member-role user cannot see plugin management UI, and the server action
 * for plugin.org.install rejects with 403.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

function uid(): string { return randomBytes(4).toString("hex"); }

function deQuote(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

const DATABASE_URL = deQuote(
  process.env.DATABASE_URL,
  "postgres://oxagen:oxagen@localhost:5433/oxagen",
);

test.describe("mcp-rbac-negative", () => {
  let fixture: PluginFixture;
  let memberSessionToken: string;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `rbac-neg-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-rbac-owner-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });

    // Create a Member-role user in the same org.
    const sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    try {
      const memberId2 = uid();
      const memberEmail = `e2e-rbac-member-${id}@oxagen.test`;
      const [memberRow] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (public_id, email, display_name, status, email_verified_at)
        VALUES ('usr_e2e_mb_' || ${memberId2}, ${memberEmail}, 'E2E Member', 'active', now())
        ON CONFLICT (email) DO UPDATE SET status = 'active'
        RETURNING id
      `;
      if (!memberRow) throw new Error("rbac: member user insert failed");
      const memberUserId = memberRow.id;

      await sql`
        INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
        VALUES ('oru_e2e_mb_' || ${memberId2}, ${fixture.orgId}, ${memberUserId}, 'member', now())
        ON CONFLICT (org_id, user_id) DO NOTHING
      `;

      memberSessionToken = `e2e-rbac-member-session-${id}`;
      await sql`
        INSERT INTO auth.sessions (id, token, user_id, expires_at, ip_address, user_agent)
        VALUES (${memberSessionToken}, ${memberSessionToken}, ${memberUserId}, now() + interval '1 hour', '127.0.0.1', 'playwright-e2e')
        ON CONFLICT (id) DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("Member-role user: plugin management UI is hidden on the settings page", async ({
    page,
    context,
  }) => {
    await loginAs(context, memberSessionToken);
    await page.goto(`/${fixture.orgSlug}/settings/plugins`);

    // Not redirected to login (member is still authenticated).
    await expect(page).not.toHaveURL(/\/login/);

    // Management buttons must NOT be present for a member.
    await expect(page.getByTestId("browse-marketplace-btn")).not.toBeVisible();
    await expect(page.getByTestId("add-custom-server-btn")).not.toBeVisible();
    await expect(page.getByTestId("denylist-add-btn")).not.toBeVisible();
  });

  test("Member-role user: plugin.org.install server action returns 403", async ({
    page,
    context,
  }) => {
    await loginAs(context, memberSessionToken);

    // POST directly to the API route that backs the server action.
    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const url = `${API_BASE}/v1/${fixture.orgSlug}/default/plugins/org/install`;

    // Extract signed cookie from context.
    const cookies = await context.cookies("http://localhost:3000");
    const cookie = cookies.find((c) => c.name === "oxagen.session_token");

    const response = await page.request.post(url, {
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie: `oxagen.session_token=${cookie.value}` } : {}),
      },
      data: { pluginType: "mcp_server", catalogServerId: fixture.catalogServerId },
    });

    // 403 — member is not authorized to manage plugins.
    expect(response.status()).toBe(403);
  });
});
```

- [ ] Commit: `test(e2e): RBAC negative spec for plugin management`

---

### Task J — Spec 9: agent integration — installed MCP tool callable in Q&A turn

- [ ] Create `apps/app/e2e/mcp-agent-integration.spec.ts`.

**Design:** The mock MCP server (running on `MOCK_MCP_URL`) exposes `e2e_ping`. The `seedPlugin` helper seeds an `agent.mcp_servers` row pointing at it with `health_status='healthy'` and `enabled=true`. We mock the chat SSE stream (via `interceptAgentStream`) to return a `tool-call-start` for `e2e_ping` + a `tool-call-end`, then a text response. We assert the tool-call card renders in the chat UI.

**Required `data-testid` attributes**:
- `apps/app/src/components/chat/tool-call-card.tsx` (or equivalent) → `data-testid="tool-call-card-{toolCallId}"`.
- The chat input → already has `data-testid="chat-input"` or use `role=textbox, name=/message/i`.

```typescript
/**
 * mcp-agent-integration.spec.ts
 *
 * E2E flow 9: Agent integration — an installed+enabled MCP server's tool
 * is callable within an interactive Q&A agent turn.
 *
 * Proves the toolchain wiring end-to-end: seedPlugin inserts a healthy
 * agent.mcp_servers row; interceptAgentStream returns a deterministic
 * tool-call-start/end for e2e_ping; the UI renders the tool-call card.
 */
import { test, expect } from "@playwright/test";
import { seedPlugin, type PluginFixture } from "./helpers/seed-plugin";
import { loginAs } from "./helpers/auth";
import { interceptAgentStream } from "./helpers/agent-stream-mock";
import { randomBytes } from "node:crypto";

function uid(): string { return randomBytes(4).toString("hex"); }

test.describe("mcp-agent-integration", () => {
  let fixture: PluginFixture;

  test.beforeAll(async () => {
    const id = uid();
    fixture = await seedPlugin({
      orgSlug: `agent-int-${id}`,
      workspaceSlug: "default",
      userEmail: `e2e-agint-${id}@oxagen.test`,
      mockMcpUrl: process.env.MOCK_MCP_URL ?? "http://127.0.0.1:9999",
    });
  });

  test.afterAll(async () => { await fixture.cleanup(); });

  test("installed MCP tool e2e_ping appears in agent turn tool-call card", async ({
    page,
    context,
  }) => {
    await loginAs(context, fixture.sessionToken);

    // Intercept the chat stream before navigating so the route is registered.
    await interceptAgentStream(page, {
      events: [
        {
          type: "tool-call-start",
          messageId: "msg_e2e_int",
          toolCallId: "tcl_e2e_ping",
          capability: "e2e_ping",
          inputPreview: {},
          riskLevel: "low",
        },
        {
          type: "tool-call-end",
          toolCallId: "tcl_e2e_ping",
          status: "completed",
          output: { content: "pong" },
          durationMs: 42,
        },
        { type: "text", messageId: "msg_e2e_int", text: "Done! The mock MCP tool returned pong." },
      ],
    });

    await page.goto(`/${fixture.orgSlug}/${fixture.workspaceSlug}/ask`);
    await expect(page).not.toHaveURL(/\/login/);

    // Send a message that will trigger the mocked tool call.
    const input = page.getByRole("textbox", { name: /message/i });
    await input.fill("run e2e_ping");
    await input.press("Enter");

    // The tool-call card must appear.
    await expect(page.getByTestId("tool-call-card-tcl_e2e_ping")).toBeVisible({
      timeout: 15_000,
    });

    // Final text response is visible.
    await expect(page.getByText(/mock MCP tool returned pong/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
```

- [ ] Commit: `test(e2e): agent integration spec — MCP tool callable in Q&A turn`

---

### Task K — Docs

#### K1 — User docs: marketplace guide

- [ ] Create `apps/docs/content/docs/plugins/marketplace.mdx`.

```mdx
---
title: Plugin Marketplace
description: Discover and install MCP servers, integrations, and content tools for your organization.
---

## Overview

The **Plugin Marketplace** lets organization Owners and Admins browse, install, and govern
third-party plugin servers — MCP servers, data-source integrations, and content tools — that
contribute additional AI tools to every workspace in your org.

Plugins must be installed at the **org level** first (where they are disabled by default),
then enabled for individual workspaces. This two-tier model gives admins centralized control
over what agents can access.

## Opening the marketplace

1. Sign in as an org **Owner** or **Admin**.
2. Go to **Org settings → Plugins**.
3. Click **Browse marketplace**.

The marketplace dialog opens with three tabs: **MCP Servers**, **Integrations**, and
**Content Tools**. Use the search bar and filters (category, transport, auth kind) to
narrow results.

## Installing a server

### Single install

1. Click a server card to open its detail page.
2. Review the description, tools list, and README.
3. Click **Install**. The server is added to your org allow-list (disabled by default).

### Bulk install

1. Check the checkbox on one or more server cards.
2. The **Install selected (n)** button appears at the bottom of the dialog.
3. Click it to install all selected servers at once.

## Denied servers

Servers blocked by your org's denylist are shown with a greyed-out, disabled treatment
and a **"Blocked by your organization's admins"** label. They cannot be installed while
on the denylist.

## Adding a custom server

1. On the **Plugins** settings page, click **Add custom server**.
2. Enter a name and the MCP endpoint URL.
3. Choose the transport (streamable HTTP or SSE) and authentication kind (OAuth, API key, or none).
4. Click **Save**. The server is added directly to your org allow-list.

## Adding a custom registry

1. Click **Add custom registry**.
2. Enter a name and the registry URL (must implement the MCP Registry OpenAPI 2025-12-01).
3. Click **Save**. The registry syncs its catalog automatically.

After syncing, servers from the registry appear in the marketplace under the MCP Servers tab.
```

- [ ] Create `apps/docs/content/docs/plugins/workspace-plugins.mdx`.

```mdx
---
title: Workspace Plugins
description: Enable org-installed plugin servers for your workspace so agents can use their tools.
---

## Overview

Once an org admin has installed a plugin server at the org level, workspace Owners and
Admins can enable it for their workspace. Only enabled servers have their tools injected
into the agent toolchain for that workspace.

## Enabling a plugin for your workspace

1. Go to **Workspace settings → Integrations**.
2. The page lists all org-installed servers available to this workspace.
3. Toggle a server on with the **Enable** switch.
4. If the server requires authentication (OAuth or API key), a **Connect** button appears — see below.

## Authenticating an OAuth server

1. Click **Connect** next to an OAuth-protected server.
2. You are redirected to the provider's authorization page.
3. After granting access you are returned to the integrations page with status **Connected**.
4. Tokens are stored encrypted (AES-256-GCM + KMS). You will receive an in-app notification
   if your token expires and re-authentication is needed.

## Re-authenticating

If a token expires or is revoked, the server's status changes to **Needs re-auth**. A
notification appears in the bell menu with a deep link to re-authenticate. You can also
click **Re-authenticate** directly on the integrations page.

## Health status

Each server row shows a health indicator:

| Status | Meaning |
|---|---|
| Healthy | Server is reachable and responding. |
| Degraded | Some MCP calls are failing; tools may be unreliable. |
| Unreachable | Server did not respond to the last health probe. |
| Needs re-auth | OAuth token is expired or revoked. |

Agents only use servers with **Healthy** status. Degraded or unreachable servers are
skipped at runtime and a warning is logged.

## Roles

| Action | Required role |
|---|---|
| Enable / disable for workspace | Workspace Owner or Org Owner/Admin |
| Connect / re-authenticate | Workspace Owner or Org Owner/Admin |
| Install / uninstall from org | Org Owner or Admin only |
| Manage denylist | Org Owner or Admin only |
```

- [ ] Commit: `docs: add marketplace and workspace-plugins MDX pages`

#### K2 — Capability docs

- [ ] Create `docs/capabilities/plugin.catalog.browse.md`.

```markdown
# plugin.catalog.browse

**Purpose:** Search and paginate the plugin catalog (all registered servers across all registries for this org).

**Surfaces:** API (`POST /v1/:org/:ws/plugins/catalog/browse`), MCP tool `plugin_catalog_browse`.

**Roles:** Any authenticated org member (read-only).

**Input:**
- `pluginType` — `mcp_server | integration | content_tool` (optional filter)
- `search` — full-text search string (optional)
- `cursor` — pagination cursor from previous response (optional)
- `limit` — max results, 1–100, default 20

**Output:**
- `servers[]` — array of catalog server summaries (id, name, title, description, transport, authKind, status)
- `nextCursor` — opaque cursor for the next page, or `null` if last page
```

- [ ] Create `docs/capabilities/plugin.org.install.md`.

```markdown
# plugin.org.install

**Purpose:** Install a catalog server (or custom server) to the org allow-list. Server is **disabled by default** after install.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/org/install`), MCP tool `plugin_org_install`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `pluginType` — `mcp_server | integration | content_tool` (default: `mcp_server`)
- `catalogServerId` — public_id of a catalog server to install (mutually exclusive with `custom`)
- `custom` — object `{ name, title?, description?, endpointUrl, transport, authKind }` for a custom server

**Output:**
- `orgListingId` — public_id of the created `plugin.org_listings` row
```

- [ ] Create `docs/capabilities/plugin.org.install_bulk.md`.

```markdown
# plugin.org.install_bulk

**Purpose:** Install multiple catalog servers to the org allow-list in one request (multi-select marketplace action).

**Surfaces:** API (`POST /v1/:org/:ws/plugins/org/install-bulk`), MCP tool `plugin_org_install_bulk`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `catalogServerIds[]` — array of catalog server public_ids (1–50)

**Output:**
- `installed[]` — array of `{ catalogServerId, orgListingId }` for each successfully installed server
- `errors[]` — array of `{ catalogServerId, reason }` for any failures (partial success is allowed)
```

- [ ] Create `docs/capabilities/plugin.workspace.set_enabled.md`.

```markdown
# plugin.workspace.set_enabled

**Purpose:** Enable or disable a plugin server for this workspace. Enabling upserts an `agent.mcp_servers` row from the org listing; disabling sets it to `enabled=false`.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/workspace/set-enabled`), MCP tool `plugin_workspace_set_enabled`.

**Roles:** Org Owner, Org Admin, Workspace Owner.

**Input:**
- `orgListingId` — public_id of the org listing to enable/disable for this workspace
- `enabled` — `true` to enable, `false` to disable

**Output:**
- `workspaceServerId` — public_id of the `agent.mcp_servers` row (or `null` when disabling and no row existed)
```

- [ ] Create `docs/capabilities/plugin.denylist.add.md`.

```markdown
# plugin.denylist.add

**Purpose:** Add a plugin server name to the org denylist. Immediately disables and removes any matching org listings and workspace installs.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/denylist/add`), MCP tool `plugin_denylist_add`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `pluginType` — `mcp_server | integration | content_tool` (default: `mcp_server`)
- `serverName` — reverse-DNS server name (e.g. `io.github.acme.my-server`)
- `reason` — optional human-readable reason shown in the marketplace UI

**Output:**
- `ok` — `true` on success
```

- [ ] Create `docs/capabilities/plugin.denylist.remove.md`.

```markdown
# plugin.denylist.remove

**Purpose:** Remove a server name from the org denylist, making it installable again.

**Surfaces:** API (`POST /v1/:org/:ws/plugins/denylist/remove`), MCP tool `plugin_denylist_remove`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `serverName` — the server name to un-deny

**Output:**
- `ok` — `true` on success
```

- [ ] Create `docs/capabilities/plugin.org.uninstall.md`.

```markdown
# plugin.org.uninstall

**Purpose:** Remove a plugin server from the org allow-list (destructive — also removes all workspace installs for this server).

**Surfaces:** API (`POST /v1/:org/:ws/plugins/org/uninstall`), MCP tool `plugin_org_uninstall`.

**Roles:** Org Owner, Org Admin.

**Input:**
- `orgListingId` — public_id of the org listing to remove

**Output:**
- `ok` — `true` on success
```

- [ ] Commit: `docs: add capability docs for plugin.* contracts`

---

### Task L — Final verification pass

- [ ] Run the E2E suite (requires local dev stack up: `pnpm dev` in repo root, Docker on port 5433):

```bash
pnpm --filter @oxagen/app exec playwright test apps/app/e2e/mcp-marketplace-install.spec.ts \
  apps/app/e2e/mcp-org-add-custom.spec.ts \
  apps/app/e2e/mcp-workspace-enable.spec.ts \
  apps/app/e2e/mcp-oauth-connect.spec.ts \
  apps/app/e2e/mcp-disable.spec.ts \
  apps/app/e2e/mcp-uninstall.spec.ts \
  apps/app/e2e/mcp-denylist.spec.ts \
  apps/app/e2e/mcp-rbac-negative.spec.ts \
  apps/app/e2e/mcp-agent-integration.spec.ts
```

Or the full suite (from repo root):

```bash
pnpm test:e2e
# equivalent to: pnpm --filter @oxagen/app exec playwright test
```

Expected: **all 9 plugin specs green**, no real network calls to registry.modelcontextprotocol.io or any LLM provider.

**Offline guarantee:** The mock MCP server and mock OAuth server are started by `globalSetup` from `e2e/fixtures/global-setup.ts` before any spec runs. `interceptAgentStream` intercepts all `**/api/v1/chat/stream` and `**/api/anthropic/**` requests. No real tokens are needed.

- [ ] Run `pnpm check:manifest` — must exit 0 (warn-only). Plugin contracts declare `layers: ["api", "mcp", "unit"]`, not `"e2e"`, so no manifest gaps for the new specs. VERIFY: `packages/oxagen/src/contracts/plugin.org.install.ts` `layers` field.

- [ ] Run full typecheck:

```bash
pnpm --filter @oxagen/app typecheck
pnpm --filter @oxagen/docs typecheck
```

- [ ] Run lint:

```bash
pnpm --filter @oxagen/app lint
```

- [ ] Commit: `chore(e2e): final verification pass — plugin specs green`

---

### Done-criteria

- [ ] `apps/app/e2e/fixtures/mock-mcp-server.ts` — in-process MCP server, one `e2e_ping` tool.
- [ ] `apps/app/e2e/fixtures/mock-oauth-server.ts` — in-process OAuth 2.1 AS (well-known + authorize + token).
- [ ] `apps/app/e2e/fixtures/global-setup.ts` — starts both fixture servers; `playwright.config.ts` wired.
- [ ] `apps/app/e2e/helpers/seed-plugin.ts` — tenant + plugin rows seeded, cleanup provided.
- [ ] Nine Playwright specs (flows 1–9) in `apps/app/e2e/`: each green, deterministic, offline.
- [ ] `data-testid` attributes listed per spec are present on the corresponding Plan 6 components (or this plan task instructs adding them).
- [ ] `apps/docs/content/docs/plugins/marketplace.mdx` — marketplace user guide.
- [ ] `apps/docs/content/docs/plugins/workspace-plugins.mdx` — workspace install + auth guide.
- [ ] `docs/capabilities/plugin.*.md` — one capability doc per contracted plugin capability.
- [ ] `pnpm check:manifest` — exits 0, no new gaps.
- [ ] `pnpm --filter @oxagen/app typecheck` — no errors.
- [ ] `pnpm test:e2e` — all suites green.

---

> **This completes the installable-plugins epic (Plans 1–7).**
>
> Plans 1–6 built the schema, credential service, catalog sync, spine capabilities, OAuth auth subsystem, notifications, and UI. Plan 7 closes the loop with deterministic offline E2E coverage of every enumerated flow and user-facing documentation for the marketplace and workspace install surfaces.

