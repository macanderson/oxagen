# Installable Plugins — MCP Servers, Integrations & Content Tools

**Status:** Approved design — ready for implementation planning
**Date:** 2026-06-06
**Author:** Mac Anderson (with Claude)
**Linear project:** `oxagen-v2`

---

## 1. Purpose

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

### Success criteria ("you're done when…")

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

## 2. What already exists (do not rebuild)

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

## 3. Architecture — five layers + shared spine

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

### The shared spine (`PluginType` interface)

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

## 4. Data model

New pg-schemas: `mcp` and `plugin` (per the per-domain `pgSchema` convention in
`_schemas.ts`). All tables use `idMixin`/`auditMixin`; soft-deletable tables add
`softDeleteMixin`. FKs declared in the SQL migration (Drizzle bare `uuid().notNull()`
convention).

### `mcp.registries`  (prefix `mreg`)
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

### `mcp.catalog_servers`  (prefix `mcat`)
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
| transport_types | text[] NOT NULL default '{}' | denormalized for filtering |
| auth_kind | text NOT NULL | derived: `oauth`\|`secret`\|`none` (heuristic: remotes present + secret vars ⇒ secret/oauth resolved at connect) |
| categories | text[] NOT NULL default '{}' | Oxagen taxonomy + `_meta` categories |
| readme_html | text NULL | sanitized, rendered from repo README |
| readme_fetched_at | timestamptz NULL | |
| status | text NOT NULL | active\|deprecated\|deleted (CHECK) |
| published_at, updated_at, status_changed_at | timestamptz | from `_meta` |
| meta | jsonb NOT NULL default '{}' | publisher `_meta` bag |
| audit | auditMixin | |

Indexes: `UNIQUE(registry_id, name, version)`, `(registry_id, name) WHERE is_latest`,
GIN on `categories`, GIN on `transport_types`, trigram on `name`/`title`/`description`
for search.

### `plugin.org_listings`  (prefix `porg`)
Org allow-list + custom plugins, polymorphic across types.

| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id | uuid NOT NULL | |
| plugin_type | text NOT NULL | `mcp_server`\|`integration`\|`content_tool` (CHECK) |
| catalog_server_id | uuid NULL | → mcp.catalog_servers (NULL ⇒ custom) |
| source | text NOT NULL | `registry`\|`custom` |
| name | text NOT NULL | stable identifier |
| title | text NULL | |
| description | text NULL | |
| icon_url | text NULL | mirrored to blob for custom |
| endpoint_url | text NULL | remote MCP/integration endpoint |
| transport | text NULL | streamable-http\|sse (remote types) |
| auth_kind | text NOT NULL | oauth\|secret\|none |
| auth_config | jsonb NOT NULL default '{}' | non-secret config (scopes, header names, discovered metadata) |
| enabled | bool NOT NULL default false | **disabled by default**; available to child workspaces |
| config | jsonb NOT NULL default '{}' | type-specific config |
| audit + softDelete | mixins | |

Indexes: `UNIQUE(org_id, plugin_type, name)`, `(org_id, plugin_type)`.

### `plugin.org_denylist`  (prefix `pden`)

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

### `agent.mcp_servers`  (existing — repurposed as workspace install)
Add columns (migration): `org_listing_id uuid NOT NULL` (→ plugin.org_listings),
keep `enabled`, `health_status`, `last_health_check_at`. Workspace can only reference an
`org_listing` whose `org_id` matches and that is not denylisted.

### `mcp.credentials`  (prefix `mcrd`) — SOC2 encrypted
Auth per `(org_listing × workspace)`. (Org-level shared creds use the `ORG_ONLY_WS`
sentinel workspace id.)

| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id, workspace_id | uuid NOT NULL | orgScopeMixin |
| org_listing_id | uuid NOT NULL | → plugin.org_listings |
| auth_kind | text NOT NULL | oauth\|secret |
| access_token_enc | bytea NULL | `encryptedBytea` |
| refresh_token_enc | bytea NULL | `encryptedBytea` |
| secret_enc | bytea NULL | for API-key/header-secret |
| token_kms_key_id | text NULL | per-row CMK |
| oauth_client_id | text NULL | from DCR |
| oauth_client_secret_enc | bytea NULL | from DCR (if confidential client) |
| scopes | text[] NOT NULL default '{}' | |
| expires_at | timestamptz NULL | |
| status | text NOT NULL | active\|needs_reauth\|revoked (CHECK) |
| last_refreshed_at | timestamptz NULL | |
| audit | auditMixin | |

Unique: `(workspace_id, org_listing_id)`. RLS-scoped (tenant seams per repo RLS policy).

### `notifications`  (prefix `ntf`) — new subsystem, `public`/`notification` schema
| Column | Type | Notes |
|---|---|---|
| id, public_id | idMixin | |
| org_id | uuid NOT NULL | |
| workspace_id | uuid NULL | |
| user_id | uuid NOT NULL | recipient |
| kind | text NOT NULL | system\|approval\|run\|member\|security (CHECK) |
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

## 5. Catalog sync

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

## 6. Auth subsystem

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

## 7. Notifications subsystem (new)

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

## 8. Capabilities — API ⇄ MCP parity

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

## 9. Agent runtime integration

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

## 10. UI

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
- Follows `oxagen-design-system` + `coss-ui` (stock coss on Base UI, `render` not `asChild`).

---

## 11. Testing

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

## 12. Out of scope (tracked as Linear epics; spine stays extensible)

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

## 13. Risks & mitigations

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

## 14. Build sequence (for the implementation plan)

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
