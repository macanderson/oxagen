# Spec: handlers-plugins

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: plugin.catalog.browse.ts, plugin.catalog.get.ts, plugin.org.install.ts, plugin.org.install_bulk.ts, plugin.org.uninstall.ts, plugin.org.list.ts, plugin.org.set_enabled.ts, plugin.workspace.set_enabled.ts, plugin.registry.add.ts, plugin.registry.list.ts, plugin.registry.remove.ts, plugin.credential.set_secret.ts, plugin.credential.reauth.ts, plugin.schema.get.ts, plugin.schema.validate.ts, plugin.version.list.ts, plugin.settings.set_auth_alerts.ts, capability-install.ts, system.install.instructions.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Browse available plugins from catalog and registries
<!-- id: plugin.catalog.browse.handler -->
<!-- entities: PluginType, PluginManifest, Registry, InstalledPlugin -->
<!-- enforced: plugin.catalog.browse.handler() -->

The marketplace SHALL enumerate Oxagen plugins (agent_capability, agent_skill, knowledge_source, integration) and MCP servers from enabled registries. Results are paginated and filtered by search, visibility, and install state. Agent_skill plugins are sourced from seeded db rows (always considered installed); static manifests (agent_capability, knowledge_source, integration) are sourced from listOxagenPlugins(); MCP servers are fetched live from workspace-enabled registries with 60-second cache.

#### Scenario: Browse static Oxagen capabilities
<!-- test: plugin.catalog.browse handler — agent_capability path — returns only ga manifests -->
- **WHEN** pluginType is "agent_capability" and visibility is not hidden or preview
- **THEN** handler returns manifests from listOxagenPlugins(), mapped with id→name, manifest.name→title, install state overlaid from pluginInstalledPlugins for (orgId, workspaceId)

#### Scenario: Browse with search filter
<!-- test: plugin.catalog.browse handler — agent_capability path — filters by search term -->
- **WHEN** search term provided (case-insensitive)
- **THEN** handler filters manifests/servers by matching id, name, or description; MCP servers are filtered after merge (in-memory)

#### Scenario: Filter by installed state
<!-- test: plugin.catalog.browse handler — agent_capability path — overlays install state from installed_plugins -->
- **WHEN** installed filter is true or false
- **THEN** handler returns only installed or uninstalled entries; agent_skill entries with installed:false are collapsed to empty result (skills are always installed)

#### Scenario: Browse agent skills from workspace
<!-- test: plugin.catalog.browse handler — agent_skill path — returns skills sorted by name -->
- **WHEN** pluginType is "agent_skill" and skills exist in agent.skills for (orgId, workspaceId) with enabled=true and deletedAt=null
- **THEN** handler returns skills from db, each mapped with authKind:"none", tier:"free", installed:true; search filters by slug, name, description (case-insensitive)

#### Scenario: Browse MCP servers from enabled registries
<!-- test: plugin.catalog.browse handler — mcp_server path — fetches and deduplicates across registries -->
- **WHEN** pluginType is "mcp_server" (or absent, defaulting to multi-type browse)
- **THEN** handler loads enabled registries for (orgId, workspaceId); fetches live from each via listServers (caching 60s per registry+search); deduplicates by server name; overlays install state from pluginInstalledPlugins; applies authKind filter in-memory; returns paginated results

#### Scenario: Fail on registry fetch timeout
<!-- test: plugin.catalog.browse handler — mcp_server path — registry fetch failure is skipped (next registry tried) -->
- **WHEN** registry fetch throws error (network timeout, malformed response)
- **THEN** handler logs warning, skips that registry, and continues with remaining registries; if no registries succeed, returns empty MCP result

#### Scenario: Handle org-less context
<!-- test: plugin.catalog.browse handler — agent_capability path — org-less browse reports nothing installed -->
- **WHEN** ctx.orgId is missing or null
- **THEN** handler returns empty result for installed:true; installed:false/undefined returns all entries without install-state overlay

---

### Requirement: Get detailed plugin specification
<!-- id: plugin.catalog.get.handler -->
<!-- entities: MCP, Registry, PluginVersion -->
<!-- enforced: plugin.catalog.get.handler() -->

The handler SHALL resolve a single MCP server by name from enabled registries, returning full metadata (title, description, icons, transport types, auth kind, categories, packages, remotes). Version defaults to "latest" (first match by name) or pinned version via getServerVersion. Search is performed across all enabled registries until first match.

#### Scenario: Get latest MCP server version
<!-- test: plugin.catalog.get handler — resolves latest by name across registries in order -->
- **WHEN** version is "latest" or omitted
- **THEN** handler iterates enabled registries (withSystemDb); calls listServers(baseUrl, {search: name, limit: 10}); returns first matching server's metadata (name, title, description, version, transport types, auth kind, etc.)

#### Scenario: Get pinned MCP server version
<!-- test: plugin.catalog.get handler — resolves exact version via getServerVersion -->
- **WHEN** version is provided and not "latest"
- **THEN** handler calls getServerVersion(baseUrl, name, version) for each registry until match found; returns server metadata for that version

#### Scenario: Server not found in any registry
<!-- test: plugin.catalog.get handler — throws error if server not found in any enabled registry -->
- **WHEN** no enabled registries contain the requested server name
- **THEN** handler throws Error("catalog server not found: {name}@{version}")

---

### Requirement: Install plugin into organization
<!-- id: plugin.org.install.handler / installOne() -->
<!-- entities: OxagenPlugin, MCP, Registry, InstalledPlugin, CapabilityPack -->
<!-- depends_on: Browse available plugins from catalog and registries -->
<!-- triggers: Enable plugin in workspace -->
<!-- enforced: plugin.org.install.handler() / installOne() -->

The handler SHALL idempotently install a plugin (agent_capability, mcp_server, integration, agent_skill, knowledge_source) into an org+workspace. Capabilities are installed from the Oxagen registry; others are installed from user-provided endpoint URL or resolved from workspace registries. All installs are enabled by default (on ON CONFLICT DO UPDATE, idempotent by design). Install succeeds or fails atomically; failures for individual items in bulk-install are returned per-item without aborting other items.

#### Scenario: Install Oxagen capability pack
<!-- test: plugin.org.install handler — capability pack path — validates visibility and upserts listing -->
- **WHEN** pluginType is "agent_capability" and pluginId matches a known Oxagen plugin with visibility != "hidden"
- **THEN** handler loads manifest via getOxagenPlugin(pluginId); calls upsertCapabilityInstall() to insert/update pluginInstalledPlugins with name=pluginId, pluginType="agent_capability", source="oxagen", authKind="none", enabled=true, endpointUrl/transport=null; returns orgListingId; emits security event plugin.installed; IDEMPOTENT: ON CONFLICT on (org_id, workspace_id, plugin_type, name) returns existing id

#### Scenario: Reject hidden Oxagen capability
<!-- test: plugin.org.install handler — capability pack path — rejects hidden plugins -->
- **WHEN** pluginId exists but manifest.visibility is "hidden"
- **THEN** handler throws Error("Plugin is not publicly installable (visibility: hidden)")

#### Scenario: Install MCP server from marketplace
<!-- test: plugin.org.install handler — mcp_server path — resolves endpoint from registry when empty URL provided -->
- **WHEN** pluginType is "mcp_server" and custom.endpointUrl is empty or omitted
- **THEN** handler enters "registry-sourced" path; iterates enabled registries for (orgId, workspaceId); calls listServers(baseUrl, {search: name, limit: 50}) for each; finds matching server; extracts first remote endpoint URL and derive transport (registry type → deriveTransportTypes + authKind via deriveAuthKind); sets source="registry"; upserts to pluginInstalledPlugins with resolved endpoint, transport, authKind, enabled=true

#### Scenario: Install custom MCP server
<!-- test: plugin.org.install handler — mcp_server path — stores custom endpoint URL directly -->
- **WHEN** pluginType is "mcp_server" and custom.endpointUrl provided (non-empty)
- **THEN** handler sets source="custom"; upserts to pluginInstalledPlugins with provided endpointUrl, transport, authKind, enabled=true (no registry lookup)

#### Scenario: Fail when server not in any registry
<!-- test: plugin.org.install handler — mcp_server path — throws error if server not found in registries -->
- **WHEN** pluginType is "mcp_server", custom.endpointUrl is empty, and server name matches no registry
- **THEN** handler throws Error("Server not found in any connected registry...")

#### Scenario: Bulk install multiple plugins
<!-- test: plugin.org.install_bulk handler — installs array of items in parallel, per-item error handling -->
- **WHEN** items array contains multiple plugin install requests
- **THEN** handler calls installOne() for each item in parallel (Promise.all); returns array of {pluginId, orgListingId, error} tuples; success does not block failure of other items; emits security event per successful install

#### Scenario: Install audit trail
<!-- test: plugin.org.install handler / plugin.org.install_bulk handler — emit plugin.installed security event -->
- **WHEN** install succeeds
- **THEN** handler calls emitSecurityEvent({eventType:"plugin.installed", capability:"plugin.org.install[_bulk]", outcome:"success", actorUserId, orgId, workspaceId, requestId}) (fire-and-forget, must not fail the capability)

---

### Requirement: Uninstall plugin from organization
<!-- id: plugin.org.uninstall.handler -->
<!-- entities: InstalledPlugin, MCP -->
<!-- enforced: plugin.org.uninstall.handler() -->

The handler SHALL soft-delete a plugin listing (scoped to org+workspace) and hard-delete all dependent MCP server rows. Uninstall is org-scoped, not workspace-scoped (removal affects all workspace settings that reference the listing).

#### Scenario: Uninstall installed plugin
<!-- test: plugin.org.uninstall handler — soft-deletes listing and hard-deletes MCP servers -->
- **WHEN** orgListingId matches a row in pluginInstalledPlugins for (orgId, workspaceId)
- **THEN** handler soft-deletes listing (set deletedAt=now()); hard-deletes all mcpServers rows with orgListingId; emits security event plugin.uninstalled with outcome:success, eventType:plugin.uninstalled

#### Scenario: Idempotent uninstall
<!-- test: plugin.org.uninstall handler — handles missing listing gracefully -->
- **WHEN** orgListingId does not match any row (already deleted or wrong org+workspace)
- **THEN** handler performs UPDATE with no matching rows (no-op); emits security event regardless (success is recorded even for no-op)

---

### Requirement: List installed plugins for organization
<!-- id: plugin.org.list.handler -->
<!-- entities: InstalledPlugin -->
<!-- enforced: plugin.org.list.handler() -->

The handler SHALL return all non-deleted plugin installations for the given org+workspace, optionally filtered by pluginType. Results are ordered by name ascending. This is a read-only operation (audit-exempt; kernel capability.invoke_* audit covers access).

#### Scenario: List all plugins
<!-- test: plugin.org.list handler — returns all installed plugins sorted by name -->
- **WHEN** pluginType filter is omitted
- **THEN** handler queries pluginInstalledPlugins WHERE (orgId, workspaceId, deletedAt=null) ORDER BY name ASC; returns array of listings with all metadata (id, publicId, createdAt, updatedAt, pluginType, source, name, title, description, iconUrl, endpointUrl, transport, authKind, authConfig, enabled, config)

#### Scenario: Filter by plugin type
<!-- test: plugin.org.list handler — filters by pluginType when provided -->
- **WHEN** pluginType filter is "mcp_server" (or other type)
- **THEN** handler adds WHERE pluginType = input.pluginType; returns filtered results

---

### Requirement: Toggle plugin enablement at org level
<!-- id: plugin.org.set_enabled.handler -->
<!-- entities: InstalledPlugin -->
<!-- enforced: plugin.org.set_enabled.handler() -->

The handler SHALL toggle the enabled flag on a plugin listing (org-level state). Enabled controls whether the plugin is available for workspace activation. Disabling does not uninstall; workspace-level MCP server rows remain until explicitly disabled via plugin.workspace.set_enabled.

#### Scenario: Enable or disable plugin
<!-- test: plugin.org.set_enabled handler — sets enabled flag to true or false -->
- **WHEN** enabled is true or false and orgListingId matches a listing for (orgId, workspaceId)
- **THEN** handler updates pluginInstalledPlugins.enabled = input.enabled; emits security event plugin.enabled_changed with outcome:success, eventType:plugin.enabled_changed

---

### Requirement: Activate or deactivate plugin at workspace level
<!-- id: plugin.workspace.set_enabled.handler -->
<!-- entities: InstalledPlugin, MCP, Workspace -->
<!-- depends_on: Install plugin into organization -->
<!-- enforced: plugin.workspace.set_enabled.handler() -->

The handler SHALL control workspace-level MCP server activation. Enabling inserts/upserts an mcpServers row (mapping installed plugin config to MCP runtime); disabling sets enabled=false on the workspace server row. Only MCP-server-based plugins (not agent_capability) can be workspace-toggled. Org-level installment must be enabled before workspace activation.

#### Scenario: Enable plugin at workspace level
<!-- test: plugin.workspace.set_enabled handler — enables MCP server — upserts mcpServers row with auth strategy -->
- **WHEN** enabled=true, orgListingId matches a non-deleted, org-level enabled listing, pluginType is not "agent_capability"
- **THEN** handler loads listing; validates installed plugin is org-enabled; maps authKind to authStrategy ("oauth"→"bearer", "secret"→"bearer", "none"→"none"); upserts mcpServers with (workspaceId, orgListingId, name, transportType, endpointUrl, authStrategy, enabled:true, healthStatus:"unknown"); ON CONFLICT on (workspaceId, orgListingId) PARTIAL WHERE orgListingId IS NOT NULL sets enabled:true, healthStatus:"unknown"; returns workspaceServerId; emits security event plugin.enabled_changed

#### Scenario: Disable plugin at workspace level
<!-- test: plugin.workspace.set_enabled handler — disables MCP server — sets enabled:false on mcpServers row -->
- **WHEN** enabled=false and mcpServers row exists for (workspaceId, orgListingId)
- **THEN** handler updates mcpServers.enabled = false; emits security event plugin.enabled_changed with outcome:success

#### Scenario: Reject workspace toggle for agent capability
<!-- test: plugin.workspace.set_enabled handler — rejects workspace-level toggle for agent_capability -->
- **WHEN** pluginType is "agent_capability"
- **THEN** handler throws Error("Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2...")

#### Scenario: Fail when org listing is not enabled
<!-- test: plugin.workspace.set_enabled handler — fails if org-level listing is disabled or missing endpoint -->
- **WHEN** enabled=true but listing.enabled is false or listing.endpointUrl is missing
- **THEN** handler throws Error("Installed plugin is disabled" or "has no endpoint URL")

---

### Requirement: Add MCP registry source to workspace
<!-- id: plugin.registry.add.handler / addRegistry() -->
<!-- entities: Registry -->
<!-- enforced: plugin.registry.add.handler() / addRegistry() -->

The handler SHALL insert a new MCP registry entry (a discovery endpoint). First registry for a workspace is automatically marked as default; subsequent registries are non-default. Default selection is automatic and immutable (no set_default capability exists).

#### Scenario: Add first registry (becomes default)
<!-- test: plugin.registry.add handler — first registry is marked is_default=true -->
- **WHEN** no other registries exist for (orgId, workspaceId)
- **THEN** handler calls addRegistry() which counts existing rows; sets isDefault=true; inserts to mcpRegistries with enabled:true; returns {id, isDefault:true}

#### Scenario: Add subsequent registries (non-default)
<!-- test: plugin.registry.add handler — subsequent registries are marked is_default=false -->
- **WHEN** ≥1 registry already exists for (orgId, workspaceId)
- **THEN** handler counts existing rows; sets isDefault=false; inserts; returns {id, isDefault:false}

---

### Requirement: List MCP registries for workspace
<!-- id: plugin.registry.list.handler -->
<!-- entities: Registry -->
<!-- enforced: plugin.registry.list.handler() -->

The handler SHALL return all MCP registries for the org+workspace (audit-exempt; read-only). Results include id, name, baseUrl, enabled, isDefault flags.

#### Scenario: List all registries
<!-- test: plugin.registry.list handler — returns registries for workspace -->
- **WHEN** workspace context provided
- **THEN** handler queries mcpRegistries WHERE (orgId, workspaceId); returns array of {id, name, baseUrl, enabled, isDefault}

---

### Requirement: Remove MCP registry from workspace
<!-- id: plugin.registry.remove.handler / removeRegistry() -->
<!-- entities: Registry -->
<!-- enforced: plugin.registry.remove.handler() / removeRegistry() -->

The handler SHALL delete an MCP registry. If the deleted registry was the default and ≥1 registry remains, the most-recently-created remaining registry is promoted to default. Delete + optional promotion are atomic (single transaction) to prevent partial-unique-index violations.

#### Scenario: Remove non-default registry
<!-- test: plugin.registry.remove handler — deletes non-default registry, no promotion -->
- **WHEN** registryId matches a non-default registry for (orgId, workspaceId)
- **THEN** handler calls removeRegistry() which deletes the row; returns {removed:true, promotedId:null}

#### Scenario: Remove default registry with alternates
<!-- test: plugin.registry.remove handler — deletes default, promotes most-recently-created remaining -->
- **WHEN** registryId matches the default registry and ≥1 other registry exists
- **THEN** handler calls removeRegistry() which deletes default row; finds remaining rows ordered by createdAt DESC, LIMIT 1; updates that row to isDefault:true; returns {removed:true, promotedId:<promoted-id>}

#### Scenario: Remove only registry
<!-- test: plugin.registry.remove handler — deletes only registry, no promotion (no rows remain) -->
- **WHEN** registryId is the only registry for (orgId, workspaceId)
- **THEN** handler deletes the row; finds no remaining rows; returns {removed:true, promotedId:null}

#### Scenario: Remove non-existent registry
<!-- test: plugin.registry.remove handler — handles missing registry gracefully -->
- **WHEN** registryId does not match any row for (orgId, workspaceId)
- **THEN** handler returns {removed:false, promotedId:null}

---

### Requirement: Set plugin credential (secret/OAuth)
<!-- id: plugin.credential.set_secret.handler -->
<!-- entities: InstalledPlugin, Credential -->
<!-- enforced: plugin.credential.set_secret.handler() -->

The handler SHALL store a plugin credential (API key, OAuth token) in KMS-wrapped storage. Authkind "secret" stores a single secret string; "oauth" stores accessToken and refreshToken. Credential storage is delegated to @oxagen/plugins KMS wrapper (envelope encryption, non-auditable per OXA-1594). This handler is audit-exempt (no plugin.credential_* event type in taxonomy; kernel capability.invoke_* audit covers invocation).

#### Scenario: Set API secret credential
<!-- test: plugin.credential.set_secret handler — stores secret for "secret" authKind -->
- **WHEN** authKind is "secret" and secret string provided
- **THEN** handler calls setWorkspaceSecret({orgId, workspaceId, orgListingId, authKind:"secret", secret, accessToken:null, refreshToken:null}); returns {ok:true}

#### Scenario: Set OAuth tokens
<!-- test: plugin.credential.set_secret handler — stores accessToken/refreshToken for "oauth" authKind -->
- **WHEN** authKind is "oauth" and accessToken (and optionally refreshToken) provided
- **THEN** handler calls setWorkspaceSecret({orgId, workspaceId, orgListingId, authKind:"oauth", secret:null, accessToken, refreshToken}); returns {ok:true}

---

### Requirement: Get OAuth reauth URL for plugin
<!-- id: plugin.credential.reauth.handler -->
<!-- entities: InstalledPlugin, OAuth -->
<!-- enforced: plugin.credential.reauth.handler() -->

The handler SHALL return an OAuth authorize URL for re-authenticating an expired or missing plugin credential. The URL points to {APP_URL}/api/v1/mcp/oauth/authorize with org slug, workspace slug, and orgListingId parameters. This is audit-exempt (read-only, does not exchange tokens; token exchange happens in the OAuth callback route).

#### Scenario: Generate reauth URL
<!-- test: plugin.credential.reauth handler — resolves slugs and constructs OAuth URL -->
- **WHEN** orgListingId provided and workspaceId scoped
- **THEN** handler queries organizations WHERE id=orgId to resolve orgSlug; queries workspaces WHERE (id, orgId) to resolve workspaceSlug; constructs authorizeUrl = {APP_URL}/api/v1/mcp/oauth/authorize?orgSlug={slug}&workspaceSlug={slug}&orgListingId={id}; returns {authorizeUrl}

#### Scenario: Fail when slugs cannot be resolved
<!-- test: plugin.credential.reauth handler — throws error if org or workspace slug missing -->
- **WHEN** org or workspace row not found
- **THEN** handler throws Error("could not resolve org or workspace slug")

---

### Requirement: Get connector schema
<!-- id: plugin.schema.get.handler -->
<!-- entities: ConnectorSchema, BuiltInConnector -->
<!-- enforced: plugin.schema.get.handler() -->

The handler SHALL return the JSON schema for a connector plugin's configuration. Schemas are sourced from DB cache (connector_schemas), then fallback to bundled YAML for built-in connectors, then fail. DB cache is automatically populated on first built-in load. Cache write failure is non-fatal (schema still returned from file).

#### Scenario: Return cached schema
<!-- test: plugin.schema.get handler — returns cached schema from DB (cache hit) -->
- **WHEN** schema exists in connector_schemas for pluginId, ordered by cachedAt DESC, LIMIT 1
- **THEN** handler returns cached schema; logs "cache hit"

#### Scenario: Load and cache built-in schema
<!-- test: plugin.schema.get handler — loads built-in YAML, inserts to cache on first access -->
- **WHEN** cache miss and loadBuiltInSchema(pluginId) returns built-in schema
- **THEN** handler inserts to connector_schemas (ON CONFLICT on (pluginId, pluginVersion) DO UPDATE schema, schemaVersion, cachedAt); returns schema; logs "loaded + cached"; non-fatal cache-write failure still returns schema from file

#### Scenario: Schema not found
<!-- test: plugin.schema.get handler — throws 404 if no cache and no built-in schema -->
- **WHEN** no cache hit and no built-in schema available
- **THEN** handler throws HTTPException(404, "Schema not found for plugin: {pluginId}")

---

### Requirement: Validate connector configuration against schema
<!-- id: plugin.schema.validate.handler -->
<!-- entities: ConnectorSchema, Config -->
<!-- enforced: plugin.schema.validate.handler() -->

The handler SHALL validate a configuration object against a connector schema. Validation is delegated to validateConfigAgainstSchema(). Schema is resolved via plugin.schema.get (DB cache + file fallback). Errors array is returned; valid=true iff errors.length=0.

#### Scenario: Valid configuration
<!-- test: plugin.schema.validate handler — returns valid:true, errors:[] for compliant config -->
- **WHEN** config matches schema for pluginId and authSchemeId
- **THEN** handler calls validateConfigAgainstSchema(config, schema, authSchemeId); returns {valid:true, errors:[]}; logs "validated"

#### Scenario: Invalid configuration
<!-- test: plugin.schema.validate handler — returns valid:false, errors:[...] for non-compliant config -->
- **WHEN** config fails schema validation
- **THEN** handler returns {valid:false, errors:[<validation-errors>]}; logs errorCount

#### Scenario: Schema not found during validation
<!-- test: plugin.schema.validate handler — propagates 404 from plugin.schema.get -->
- **WHEN** schema not found for pluginId
- **THEN** handler calls plugin.schema.get, catches HTTPException 404, and re-throws

---

### Requirement: List available plugin versions
<!-- id: plugin.version.list.handler -->
<!-- entities: PluginVersion -->
<!-- enforced: plugin.version.list.handler() -->

The handler SHALL return version history for a plugin (stub implementation). Currently returns fixed currentVersion="1.0.0", no installed versions, no breaking updates, empty versions array. Future implementation SHALL query plugin catalog/registry and compare against org's installed version.

#### Scenario: List versions (stub)
<!-- test: plugin.version.list handler — returns stub version list (TODO: fetch from catalog) -->
- **WHEN** pluginId and limit provided
- **THEN** handler logs "fetched (stub)"; returns {pluginId, currentVersion:"1.0.0", installedVersion:null, hasBreakingUpdate:false, versions:[]}

---

### Requirement: Set MCP authentication alert preferences
<!-- id: plugin.settings.set_auth_alerts.handler -->
<!-- entities: Organization -->
<!-- enforced: plugin.settings.set_auth_alerts.handler() -->

The handler SHALL update org-level notification preferences for MCP authentication failures. Preference is stored in organizations.settings as a JSON fragment {mcp_auth_alerts: {send_email: boolean, roles: [string]}}. This is audit-exempt (delivery setting, not access control or credential change; covered by kernel capability.invoke_* audit).

#### Scenario: Set email alert preferences
<!-- test: plugin.settings.set_auth_alerts handler — updates org settings with mcp_auth_alerts config -->
- **WHEN** sendEmail and roles array provided
- **THEN** handler constructs JSON fragment {mcp_auth_alerts: {send_email, roles}}; updates organizations.settings = settings || {fragment}::jsonb WHERE orgId; returns {ok:true}

---

### Requirement: Idempotently upsert agent capability plugin
<!-- id: upsertCapabilityInstall() -->
<!-- entities: OxagenPlugin, InstalledPlugin -->
<!-- enforced: capability-install.upsertCapabilityInstall() -->

This is a shared helper (extracted from plugin.org.install) for idempotent agent_capability upsert. Used by plugin.org.install and workspace-capability-seed without going through install's visibility validation or audit events. ON CONFLICT on (org_id, workspace_id, plugin_type, name) unique index returns existing row id or inserts new row.

#### Scenario: Upsert new capability
<!-- test: plugin.org.install handler — capability pack path — upserts capability listing -->
- **WHEN** capability not yet installed for (orgId, workspaceId)
- **THEN** function inserts pluginInstalledPlugins with pluginType="agent_capability", source="oxagen", name=pluginId, title=manifest.name, description=manifest.description, authKind="none", enabled=true, endpointUrl/transport/iconUrl=null; returns inserted id

#### Scenario: Idempotent re-upsert
<!-- test: plugin.org.install handler — capability pack path — ON CONFLICT DO UPDATE (idempotent) -->
- **WHEN** capability already installed for (orgId, workspaceId)
- **THEN** function hits ON CONFLICT unique index; executes DO UPDATE with updatedAt=now(); returns existing id (no change to other fields)

---

### Requirement: Provide step-by-step MCP integration instructions
<!-- id: system.install.instructions.handler -->
<!-- entities: InstallClient -->
<!-- enforced: system.install.instructions.handler() -->

The handler SHALL return platform-specific installation steps for connecting Oxagen MCP to a user's IDE/editor (Claude Code, Cursor, Claude Desktop, Codex, VS Code). Each client receives tailored instructions (an `mcp add` command for Claude Code, config file edits for Claude Desktop/Cursor/VS Code, yaml for Codex). Instructions include API key generation, MCP URL, and verification steps. Workspace slug is interpolated into steps when available.

#### Scenario: Installation steps for Claude Code
<!-- test: system.install.instructions handler — stepsForClaudeCode — includes claude mcp add -->
- **WHEN** client is "claude-code" and workspaceSlug provided (or default placeholder)
- **THEN** handler returns array of InstallStep[]: generate an API key, `claude mcp add oxagen --transport http --url {MCP_URL}/mcp --header "Authorization: Bearer $OXAGEN_API_KEY"`, `claude mcp list` (verify), and start a session

#### Scenario: Installation steps for Claude Desktop
<!-- test: system.install.instructions handler — stepsForClaudeDesktop — includes config file path and JSON entry -->
- **WHEN** client is "claude-desktop"
- **THEN** handler returns array of InstallStep[]: (1) Generate API key at {APP_URL}/settings/api-keys, (2) Open ~/Library/Application Support/Claude/claude_desktop_config.json, (3) Add mcpServers.oxagen entry (JSON snippet), (4) Add API key to Authorization header, (5) Restart Claude Desktop

#### Scenario: Installation steps for Cursor
<!-- test: system.install.instructions handler — stepsForCursor — includes MCP settings UI and auth header -->
- **WHEN** client is "cursor"
- **THEN** handler returns array of InstallStep[]: (1) Cursor Settings → MCP Servers, (2) Click "Add new server", enter MCP_URL, (3) Set transport to HTTP, (4) Generate API key, (5) Paste API key to Authorization header, (6) Reload Cursor

#### Scenario: Installation steps for VS Code
<!-- test: system.install.instructions handler — stepsForVscode — includes extension install and settings.json -->
- **WHEN** client is "vscode"
- **THEN** handler returns array of InstallStep[]: (1) code --install-extension anthropic.claude-code (if needed), (2) Generate API key, (3) Add mcp.servers.oxagen to settings.json, (4) Add API key to Authorization header, (5) Reload window

#### Scenario: Installation steps for Codex
<!-- test: system.install.instructions handler — stepsForCodex — includes codex.yaml config entry -->
- **WHEN** client is "codex"
- **THEN** handler returns array of InstallStep[]: (1) Generate API key, (2) Add mcp_servers.oxagen to codex.yaml (with url, transport, Authorization header), (3) codex tools list (verify)

#### Scenario: Render component output
<!-- test: system.install.instructions handler — returns componentId and props for rendering -->
- **WHEN** handler returns result
- **THEN** result includes render field: {componentId:"install-instructions", props:{client, steps}}

---

### Invariant: Plugin installation is idempotent
<!-- entities: InstalledPlugin -->
<!-- enforced: plugin.org.install.handler() / installOne() -->

Repeated install of the same plugin SHALL always succeed without error and return the same orgListingId. The underlying INSERT uses ON CONFLICT on (org_id, workspace_id, plugin_type, name) DO UPDATE, guaranteeing idempotency across all plugin types.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: First registry for workspace is always marked default
<!-- entities: Registry -->
<!-- enforced: addRegistry() / plugin.registry.add.handler() -->

For any org+workspace, exactly one registry SHALL have isDefault=true (when ≥1 registry exists). When the first registry is added, isDefault is automatically set true. When the default is removed and ≥1 alternative remains, the most-recently-created remaining registry is automatically promoted. There is no user-facing API to manually set or toggle default.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Workspace-scoped MCP server rows cascade on uninstall
<!-- entities: InstalledPlugin, MCP, Workspace -->
<!-- enforced: plugin.org.uninstall.handler() -->

When a plugin is uninstalled at org level, all workspace-scoped mcpServers rows referencing that orgListingId SHALL be hard-deleted (not soft-deleted) so the MCP runtime does not attempt to load disconnected servers. The deletion is performed inside the same transaction as the plugin listing soft-delete.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Registry fetch failures do not block catalog browse
<!-- entities: Registry, MCP -->
<!-- enforced: plugin.catalog.browse.handler() -->

If an enabled registry fails to respond (network error, timeout, malformed response), the handler SHALL log a warning and continue with the next registry. A partial registry failure does not cancel the entire browse operation; results are merged from all succeeding registries.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Tenant isolation on credential storage
<!-- entities: InstalledPlugin, Credential -->
<!-- enforced: plugin.credential.set_secret.handler() -->

Secrets and OAuth tokens are stored in KMS-wrapped (envelope-encrypted) storage scoped to (orgId, workspaceId, orgListingId). Tenant isolation is enforced at the @oxagen/plugins KMS seam; handler passes (orgId, workspaceId) explicitly to setWorkspaceSecret().

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Agent capability plugins cannot be workspace-toggled
<!-- entities: OxagenPlugin, Workspace -->
<!-- enforced: plugin.workspace.set_enabled.handler() -->

Agent_capability plugins (Oxagen capability packs) are invoked internally and do not have workspace-level MCP server rows. Attempts to call plugin.workspace.set_enabled with pluginType="agent_capability" SHALL throw error "Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2...". Capability packs remain under org-level control only (plugin.org.set_enabled).

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Hidden and preview plugins are excluded from marketplace
<!-- entities: PluginManifest, Visibility -->
<!-- enforced: plugin.catalog.browse.handler() -->

Manifests with visibility="hidden" or visibility="preview" are filtered out of browse results. Only visibility="ga" (general availability) manifests are returned. Hidden visibility also guards install attempts (plugin.org.install rejects hidden manifests explicitly).

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: MCP registry fetch is cached 60 seconds per search
<!-- entities: Registry, Cache -->
<!-- enforced: plugin.catalog.browse.handler() -->

The listServers() response from each enabled registry is cached in-memory (module scope) with 60-second TTL. Cache key is {registryId}:{search-term}. Different search queries are cached independently. Cache survives across requests in the same Node.js process and is cleared between test runs via clearRegistryCacheForTests().

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Bulk install does not abort on per-item failure
<!-- entities: InstalledPlugin -->
<!-- enforced: plugin.org.install_bulk.handler() -->

When installing multiple plugins in bulk, the failure of one plugin SHALL NOT prevent installation of others. Each item is processed independently via Promise.all(); failures are collected in the returned array with {error: message}. Handler always returns a result array; callers must inspect per-item error fields.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Schema cache write failure does not block schema retrieval
<!-- entities: ConnectorSchema, Cache -->
<!-- enforced: plugin.schema.get.handler() -->

If a built-in schema is loaded and DB cache insertion fails, the schema is still returned (non-fatal write failure). Handler logs warning and returns the loaded schema from file. Future requests will miss the cache and re-load from file until write succeeds.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Audit events are fire-and-forget
<!-- entities: AuditEvent, SecurityEvent -->
<!-- enforced: emitSecurityEvent() calls in plugin handlers -->

Security event emission via emitSecurityEvent() is fire-and-forget (not awaited). If event emission fails, handler does NOT retry or fail the capability. Exceptions are logged only. Audit trail completeness is best-effort; missing audit events do not block plugin operations.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: plugin.governance.audit.ts is referenced in test file (plugin.governance.audit.test.ts) but no handler file exists; functionality appears to be delegated to audit.log.query.handler() or remains unimplemented -->

<!-- uncertainty: plugin.version.list is a stub; actual version list, installed version comparison, and breaking-update detection not yet implemented; current behavior is hardcoded -->
