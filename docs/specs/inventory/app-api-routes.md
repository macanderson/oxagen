# Spec: app-api-routes

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: apps/app/src/app/api/v1/{chat/stream, assets, conversations, stripe, upload, plugin/catalog, mcp/oauth}
> Last verified: 2026-06-20 (commit 2f628504)

---

## Description

Next.js App Router route handlers at `apps/app/src/app/api/v1/` that expose the application's HTTP API surface. Covers chat streaming, asset serving, conversation metadata, billing checkout, avatar uploads, plugin catalog discovery, and OAuth integration for MCP servers. All routes enforce session-based authentication at the application boundary and delegate capability-scoped work to `invoke()` for metering, IAM, and tenancy.

---

### Requirement: Chat stream accepts user message and streams agent reply as SSE

<!-- id: route.POST -->
<!-- entities: Session, User, Organization, Workspace, Conversation, Message, Model, Tool -->
<!-- enforced: route.ts:POST() -->
<!-- depends_on: Session authentication check, Organization membership check, Workspace resolution -->

POST /api/v1/chat/stream accepts JSON body with user message content, optional conversation/parent context, model/tier selection, and page-context form metadata. Routes through session auth → org/workspace resolution → membership gate → model selection (explicit id or tier or defaults) → tool materialization → agent reply streaming. Streams reply as text/event-stream with `data: <JSON StreamEvent>\n\n` lines followed by `event: done\ndata: [DONE]\n\n` terminal sentinel. On auth failure, returns 401. On validation failure, returns 400. On org/workspace not found, returns 404.

#### Scenario: Authenticated user sends message in existing conversation
<!-- test: e2e/agent-stream-mock.ts intercepts URL for deterministic testing -->
- **WHEN** authenticated session, valid orgSlug/workspaceSlug, conversationId set, parentMessageId set, content provided
- **THEN** system fetches up to 50 most-recent messages (DESC createdAt + LIMIT, reversed chronological), loads tenant-scoped workspace context (knowledge graph blocks, defaults to empty), constructs message history with knowledge-graph system message prepended, materializes workspace-scoped MCP server tools + page_form_fill tool (if page context has fillableForm), calls streamAgentReply with merged tool set + resolved model + system prompt (with workspace prompt config overlaid), emits text/reasoning/tool-call/step/component/usage SSE events as agent processes, persists final assistant reply to messages table with contentBlocks, advances conversation.activeLeafMessageId, fires fire-and-forget auto-title generation on newConversation=true

#### Scenario: Unauthenticated or invalid session
- **WHEN** getSessionOrRedirect throws or session is null
- **THEN** returns 401 Unauthorized before consuming body

#### Scenario: Invalid JSON body
- **WHEN** request body is not valid JSON
- **THEN** returns 400 Invalid JSON body

#### Scenario: Body validation fails (missing required fields, wrong enum values)
- **WHEN** BodySchema.safeParse fails (e.g. content empty, tier not in [fast, balanced, precise])
- **THEN** returns 400 with error message from Zod validation issue

#### Scenario: Organization slug does not resolve or workspace not found
- **WHEN** resolveOrg(orgSlug) fails or assertOrgMember fails or resolveWorkspace fails
- **THEN** returns 404 Org or workspace not found

#### Scenario: User requests image generation instead of text agent
- **WHEN** generate set to "image", mediaModel or mediaTier provided
- **THEN** resolves media model (explicit mediaModel → effective workspace/user default → tier default), calls streamMediaGeneration with kind="image", returns image-preview component SSE event stream

#### Scenario: User requests video generation (async)
- **WHEN** generate set to "video", mediaTier or mediaModel provided
- **THEN** resolves media model, creates pending generated_assets row, dispatches agent/video.render Inngest job, returns video-result component SSE that polls for completion

#### Scenario: Page context with fillable form is provided
- **WHEN** pageContext includes fillableForm with formId, title, fields, form fields array has ≤60 entries, all field names/labels ≤256 chars, entitySummary ≤500 chars, route ≤2048 chars
- **THEN** registers request-scoped page_form_fill tool, appends form metadata to system prompt, tool routes form.fill invoke through kernel for IAM + metering

#### Scenario: Page context is null or absent
- **WHEN** pageContext null or omitted
- **THEN** no page_form_fill tool registered, system prompt baseline only

#### Scenario: Explicit model id overrides tier
- **WHEN** model string provided (e.g. "anthropic/claude-3-5-sonnet")
- **THEN** ignores tier, uses explicit model id via selectModel

#### Scenario: Reasoning effort provided for reasoning-capable model
- **WHEN** effort enum [low, medium, high] AND supportsReasoning(modelIdOf(turnModel)) is true
- **THEN** forwards effort to streamAgentReply; otherwise drops effort

#### Scenario: Current message already in history
- **WHEN** message fetched from history has same role='user' and same content as request body content
- **THEN** does not append current message again (sent concurrently from sendMessageAction); uses fetched history as-is

#### Scenario: Database persistence fails after SSE stream consumed
- **WHEN** runInTenantScope → withTenantDb insert/update throws during persistence
- **THEN** logs error, does NOT corrupt response stream client already consumed; stream remains valid through completion

#### Scenario: Auto-title generation concurrent calls
- **WHEN** newConversation=true AND multiple first-turn requests race
- **THEN** autoTitleConversation idempotent via isNull(conversations.title) WHERE clause; only first write succeeds, others silently no-op

---

### Requirement: Generated assets are served access-controlled with zero cache

<!-- id: route.GET -->
<!-- entities: Session, User, Organization, Workspace, GeneratedAsset, BlobStorage -->
<!-- enforced: route.ts:GET() -->

GET /api/v1/assets/[assetId] resolves session (authenticated or null for public assets), calls serveGeneratedAsset(assetId, { userId, surface: "app" }), which enforces asset access policy (user-owned, org-owned, or public) and returns body stream + metadata. Returns 404 for not-found or forbidden assets (no 403 leak). Cache header "private, max-age=0, must-revalidate" ensures no stale-cached asset from another session.

#### Scenario: Authenticated user retrieves their own asset
- **WHEN** session present, assetId in database with accessPolicy=user and createdByUserId matches session.user.id
- **THEN** serveGeneratedAsset returns { body (stream from blob), mimeType, contentDisposition, sizeBytes }, HTTP 200 with private cache-control

#### Scenario: Authenticated user retrieves org-scoped asset
- **WHEN** session present, assetId accessPolicy=org, user is member of asset.orgId
- **THEN** HTTP 200 with body stream, private cache-control

#### Scenario: Public asset accessed with or without session
- **WHEN** assetId accessPolicy=public, session irrelevant
- **THEN** HTTP 200 with body stream

#### Scenario: Asset not found
- **WHEN** assetId does not exist
- **THEN** returns 404 Not Found (serveGeneratedAsset throws GeneratedAssetNotFoundError)

#### Scenario: User lacks permission
- **WHEN** assetId exists but accessPolicy=org and user not in org, OR accessPolicy=user and user not creator, AND session present
- **THEN** returns 404 Not Found (no 403 leak; serveGeneratedAsset throws GeneratedAssetForbiddenError)

#### Scenario: Unauthenticated access to non-public asset
- **WHEN** session null, assetId accessPolicy=user or org
- **THEN** returns 404 (serveGeneratedAsset rejects null userId for protected assets)

---

### Requirement: Conversation assets list is served access-controlled via capability invoke

<!-- id: route.GET -->
<!-- entities: Session, User, Organization, Workspace, Conversation, GeneratedAsset -->
<!-- enforced: route.ts:GET() -->
<!-- triggers: Conversation.files.list capability is invoked with server-side context -->

GET /api/v1/conversations/[conversationId]/assets returns conversation's generated assets newest-first. Authenticates session → resolves conversation's org/workspace from system DB (no ALS scope in route handler) → verifies user is org member → constructs capabilityCtx with resolved org/workspace → invokes conversation.files.list capability (metering + IAM + tenant RLS flow through invoke) → returns JSON array of ConversationAssetItem. Returns 401 for unauthenticated. Returns 404 for conversation not found OR user not in org OR conversation out of scope (capability re-checks).

#### Scenario: Authenticated user lists assets in their workspace conversation
- **WHEN** session present, conversationId resolves to workspace in user's org, conversation.deletedAt null
- **THEN** resolveWorkspaceScope confirms membership, invoke("conversation.files.list", …) returns { files: ConversationAssetItem[] }, HTTP 200 with JSON array ordered createdAt DESC

#### Scenario: Unauthenticated request
- **WHEN** getSession returns null user
- **THEN** returns 401 Unauthorized

#### Scenario: Conversation does not exist
- **WHEN** conversationId publicId does not match any row or conversation.deletedAt not null
- **THEN** returns 404 Not Found

#### Scenario: User not in conversation's organization
- **WHEN** conversation found, but user has no orgUsers row for conversation.orgId
- **THEN** returns 404 Not Found (no 403 leak)

#### Scenario: Conversation.files.list handler throws "not found"
- **WHEN** invoke throws with "not found" message (capability re-checked scoping)
- **THEN** returns 404 Not Found; other errors return 500

---

### Requirement: Stripe checkout returns session URL for subscription upgrade

<!-- id: route.POST -->
<!-- entities: Session, User, Organization, BillingSubscription, StripeSession -->
<!-- enforced: route.ts:POST() -->
<!-- depends_on: Session authentication check, Billing manager role check -->

POST /api/v1/stripe/checkout accepts JSON body { orgSlug, planSlug, interval: month|year }. Authenticates session → resolves org from orgSlug → asserts user is billing manager (owner/admin/billing role) → constructs successUrl/cancelUrl with NEXT_PUBLIC_APP_URL env → invokes billing.subscription.upgrade.start capability with planSlug, interval, successUrl, cancelUrl → returns { url: checkoutUrl } (Stripe checkout session URL). Returns 401 for unauthenticated. Returns 400 for invalid body. Returns 404 for org not found. Returns 403 (implicit via assertBillingManager) for non-manager. Returns 500/404 on capability handler error (404 when message contains "not found", 400 when contains "no", else 500).

#### Scenario: Billing manager initiates paid checkout
- **WHEN** session present, user is owner/admin/billing for org, planSlug valid (e.g. "pro-monthly"), interval in [month, year]
- **THEN** billing.subscription.upgrade.start handler generates Stripe checkout session, returns checkoutUrl, HTTP 200 with { url }

#### Scenario: Non-manager attempts checkout
- **WHEN** session present, user is org member but not manager
- **THEN** assertBillingManager throws, HTTP 403 (implicit)

#### Scenario: Organization not found
- **WHEN** orgSlug does not resolve
- **THEN** returns 404

#### Scenario: Invalid request body
- **WHEN** orgSlug/planSlug missing, interval not month|year
- **THEN** returns 400 Invalid body

---

### Requirement: Avatar upload stores file server-side with key derivation

<!-- id: route.POST -->
<!-- entities: Session, User, BlobStorage -->
<!-- enforced: route.ts:POST() -->

POST /api/v1/upload/avatar accepts multipart/form-data with file field (cropped image). Authenticates session → parses form → validates MIME type (PNG/JPEG/WebP via assertAllowedAssetType) → checks file size ≤ ASSET_LIMITS.avatar (5 MB) → derives storage key server-side from user id + UUID (no client control of path) → stores to blob storage via storage().put() with access: public → returns { url } (201). Returns 401 for unauthenticated. Returns 400 for missing file, invalid form, or file size 0. Returns 415 for unsupported MIME type. Returns 413 for file exceeds 5 MB. Returns 503 for missing BLOB_READ_WRITE_TOKEN (misconfiguration). Returns 500 for other storage errors.

#### Scenario: Authenticated user uploads avatar image
- **WHEN** session present, file is PNG/JPEG/WebP, 0 < size ≤ 5 MB, form field named "file"
- **THEN** assertAllowedAssetType("avatar", file.type) succeeds, key derived from userId + randomUUID, storage().put({ key, body, contentType, access: "public" }) succeeds, HTTP 201 with { url }

#### Scenario: File MIME type not supported
- **WHEN** file.type not in [image/png, image/jpeg, image/webp]
- **THEN** assertAllowedAssetType throws, returns 415 Unsupported image type

#### Scenario: File exceeds size limit
- **WHEN** file.size > 5 MB
- **THEN** returns 413 Image exceeds the 5 MB limit

#### Scenario: No file uploaded or wrong form field name
- **WHEN** form.get("file") returns null or non-File value
- **THEN** returns 400 Missing file

#### Scenario: Blob storage misconfigured
- **WHEN** BLOB_READ_WRITE_TOKEN missing or invalid
- **THEN** storage().put() throws with "BLOB_READ_WRITE_TOKEN" in message, returns 503 Service Unavailable

---

### Requirement: Plugin catalog GET returns single server detail

<!-- id: route.GET -->
<!-- entities: Session, User, Organization, Workspace, Plugin, PluginCatalog -->
<!-- enforced: route.ts:GET() -->

GET /api/v1/plugin/catalog/get?name=<name>[&version=<version>][&workspaceId=<id>] returns full catalog detail for a single server (e.g. @anthropic-ai/mcp-server-brave-search). Authenticates session → validates name (required), version (optional, default "latest"), workspaceId (required) → resolveWorkspaceScope confirms workspace exists and user is member → invokes plugin.catalog.get with name, version → returns catalog server object. Returns 401 for unauthenticated. Returns 400 for missing name. Returns 404 for workspace not found or access denied. Returns 500 for handler errors.

#### Scenario: User fetches catalog detail for latest version
- **WHEN** session present, name="@anthropic-ai/mcp-server-brave-search", version omitted (defaults to "latest"), workspaceId resolves to user's workspace
- **THEN** resolveWorkspaceScope succeeds, invoke("plugin.catalog.get", { name, version: "latest" }, …) returns { /* server metadata: description, versions, install status, etc */ }, HTTP 200 with JSON

#### Scenario: User fetches specific semver version
- **WHEN** name provided, version="1.0.5", workspaceId valid
- **THEN** invoke("plugin.catalog.get", { name, version: "1.0.5" }, …) returns detail for that version

#### Scenario: Name query param missing
- **WHEN** name not in query params
- **THEN** returns 400 name is required

#### Scenario: Workspace not found or user lacks access
- **WHEN** workspaceId does not exist OR user not member
- **THEN** resolveWorkspaceScope returns null, returns 404 Workspace not found or access denied

---

### Requirement: Plugin catalog BROWSE returns paginated list with filters

<!-- id: route.GET -->
<!-- entities: Session, User, Organization, Workspace, Plugin, PluginCatalog -->
<!-- enforced: route.ts:GET() -->

GET /api/v1/plugin/catalog/browse?[search=][&pluginType=][&authKind=][&installed=][&workspaceId=][&limit=][&offset=] returns paginated catalog servers. Authenticates session → resolves workspaceId (server-side only, client-supplied orgId never trusted) → validates optional filters: pluginType [mcp_server|integration|agent_capability|agent_skill|knowledge_source], authKind [oauth|secret|none], installed [true|false], search (text), limit (1-100, default 30), offset (≥0, default 0) → invokes plugin.catalog.browse with all params → returns paginated result. Returns 401 for unauthenticated. Returns 404 for workspace not found or access denied. Returns 500 for handler errors.

#### Scenario: User browses all MCP servers with limit pagination
- **WHEN** session present, workspaceId valid, limit=20, offset=0, other filters omitted
- **THEN** resolveWorkspaceScope succeeds, invoke("plugin.catalog.browse", { search: undefined, authKind: undefined, pluginType: undefined, installed: undefined, limit: 20, offset: 0 }, …) returns { /* paginated list of servers */ }, HTTP 200 with JSON

#### Scenario: Filter by plugin type
- **WHEN** pluginType="mcp_server"
- **THEN** only mcp_server entries returned

#### Scenario: Filter by auth kind
- **WHEN** authKind="oauth"
- **THEN** only OAuth-protected servers returned

#### Scenario: Filter by installation status
- **WHEN** installed="true"
- **THEN** only servers already installed in workspace returned; installed="false" returns uninstalled

#### Scenario: Text search
- **WHEN** search="brave"
- **THEN** catalog servers matched by name/description containing "brave"

#### Scenario: Limit capped at 100
- **WHEN** limit=500
- **THEN** request capped to limit=100 (Math.min(500, 100))

#### Scenario: Offset validated
- **WHEN** offset=-5
- **THEN** request normalized to offset=0 (Math.max(-5, 0))

---

### Requirement: MCP OAuth authorize starts authorization flow

<!-- id: route.GET -->
<!-- entities: Session, User, Organization, Workspace, PluginInstalledPlugin, OAuthState, DbOAuthClientProvider -->
<!-- enforced: route.ts:GET() -->
<!-- depends_on: Session authentication check, MCP manager role check -->

GET /api/v1/mcp/oauth/authorize?orgSlug=&workspaceSlug=&orgListingId= starts OAuth 2.1 authorization flow for an OAuth-protected MCP server. Authenticates session → validates orgSlug, workspaceSlug, orgListingId (required) → resolves org/workspace → asserts user is MCP manager (owner/admin) → queries pluginInstalledPlugins for orgListingId → generates state UUID + redirectUrl/returnTo → constructs DbOAuthClientProvider with safeFetch wrapper (handles Next.js fetch deadlock/hanging) → calls mcpAuth(provider, { serverUrl: listing.endpointUrl }) → returns either "REDIRECT" (authorization server URL) or "AUTHORIZED" (already connected). Returns 401 for unauthenticated. Returns 400 for missing params. Returns 404 for org/workspace/listing not found. Returns 502 for mcpAuth failure.

#### Scenario: MCP manager initiates OAuth for new server
- **WHEN** session present, orgSlug valid, user is org owner/admin, workspaceSlug valid, orgListingId exists with endpointUrl, user has not yet authorized
- **THEN** mcpAuth returns "REDIRECT", generates authorization server URL, HTTP 302 redirect to authorization server authorize endpoint (safeFetch wrapper ensures no deadlock on well-known discovery)

#### Scenario: Server already authorized
- **WHEN** orgListingId already has valid OAuth tokens stored
- **THEN** mcpAuth returns "AUTHORIZED", HTTP 302 redirect to `/<orgSlug>/<workspaceSlug>/settings/integrations?mcp=already-connected`

#### Scenario: Non-manager attempts authorization
- **WHEN** session present, user is workspace member but not owner/admin
- **THEN** assertMcpManager throws, HTTP 401 (implicit, or 403 per role check implementation)

#### Scenario: Listing not found or not OAuth-connectable
- **WHEN** orgListingId does not exist OR listing.orgId != tenant.id OR listing.endpointUrl null
- **THEN** returns 404 listing not found or not connectable

#### Scenario: mcpAuth fails
- **WHEN** authorization server returns 5xx, network error, or SDK throws during OAuth discovery
- **THEN** logs error, returns 502 mcp auth failed with detail

---

### Requirement: MCP OAuth callback exchanges code for tokens and upserts install

<!-- id: route.GET -->
<!-- entities: OAuthState, PluginInstalledPlugin, McpServer, DbOAuthClientProvider -->
<!-- enforced: route.ts:GET() -->
<!-- triggers: mcpServers table upsert (create or reconnect), mcp-servers-ws-listing-uniq partial unique index -->

GET /api/v1/mcp/oauth/callback?code=&state= exchanges authorization code for tokens, stores encrypted credentials, upserts mcpServers workspace install row. Parses code + state from query → loads OAuth state from ephemeral storage via loadOAuthState(state, Date.now()) (expires if >timeout) → queries pluginInstalledPlugins for orgListingId from state → constructs DbOAuthClientProvider with stored metadata → calls mcpAuth(provider, { serverUrl, authorizationCode: code }) to exchange code for tokens → deletes ephemeral state regardless of outcome → if result="AUTHORIZED", upserts mcpServers row (CREATE if new, UPDATE if reconnect, idempotent via mcp_servers_ws_listing_uniq partial unique index) with healthStatus=healthy, enabled=true → returns HTTP 302 redirect to returnTo URL. Returns 400 for missing code/state. Returns 400 if state expired/not found. Returns 404 if listing gone. Returns 502 if mcpAuth fails. No session required (callback is from authorization server, not user).

#### Scenario: Authorization code successfully exchanged
- **WHEN** code + state valid, state data found and not expired, listing.endpointUrl exists, mcpAuth returns "AUTHORIZED"
- **THEN** DbOAuthClientProvider stores tokens encrypted, mcpServers INSERT into database with authStrategy=bearer, healthStatus=healthy, enabled=true (or UPDATE if orgListingId already installed), HTTP 302 redirect to `/<orgSlug>/<workspaceSlug>/settings/integrations?mcp=connected`

#### Scenario: State not found or expired
- **WHEN** state does not exist in ephemeral storage OR timeout exceeded
- **THEN** logs warning, returns 400 state expired or not found, does not attempt token exchange

#### Scenario: Listing deleted between authorize and callback
- **WHEN** code + state valid, but orgListingId does not exist in pluginInstalledPlugins
- **THEN** returns 404 listing gone, does not attempt token exchange

#### Scenario: Reconnect flow (already installed)
- **WHEN** code + state valid, orgListingId already has mcpServers row for workspace
- **THEN** ON CONFLICT DO UPDATE sets healthStatus=healthy, enabled=true, updatedAt=now(), keeps existing authConfig/tokens, HTTP 302 redirect with ?mcp=connected

#### Scenario: mcpAuth fails during token exchange
- **WHEN** authorization server returns 4xx/5xx or network error
- **THEN** mcpAuth throws, state deleted regardless, HTTP 302 redirect to returnTo?mcp=error

---

### Invariant: Session authentication is the application boundary

<!-- entities: Session, User -->
<!-- enforced: getSessionOrRedirect(), getSession() in every route handler -->

Every route handler that requires authentication calls getSessionOrRedirect() (which throws on auth failure) or getSession() (which returns null if unauthenticated), never trusting unauthenticated requests to access tenant-scoped data. POST /api/v1/chat/stream, GET /api/v1/assets/[assetId], GET /api/v1/conversations/[conversationId]/assets, POST /api/v1/stripe/checkout, POST /api/v1/upload/avatar, GET /api/v1/plugin/catalog/get, GET /api/v1/plugin/catalog/browse all gate on session before consuming request body or DB queries. GET /api/v1/mcp/oauth/callback does not require session (authorization server callback, state validates the flow).

---

### Invariant: Tenant isolation is enforced at the application boundary

<!-- entities: Session, User, Organization, Workspace -->
<!-- enforced: resolveOrg(), assertOrgMember(), resolveWorkspace(), resolveWorkspaceScope() in routes, runInTenantScope() + withTenantDb() for tenant-scoped queries -->

Routes that accept orgSlug or workspaceSlug from the client always resolve server-side and assert org membership before touching tenant-scoped data (IDOR defense). POST /api/v1/chat/stream calls resolveOrg(orgSlug) + assertOrgMember() + resolveWorkspace(). GET /api/v1/conversations/[conversationId]/assets resolves conversation's org/workspace from system DB, then verifies user is org member. GET /api/v1/stripe/checkout resolves org from orgSlug + assertBillingManager(). GET /api/v1/plugin/catalog/get/browse use resolveWorkspaceScope() to resolve and validate workspace membership server-side; client-supplied orgId never trusted. All tenant-scoped queries (messages, conversations, generated_assets) wrapped in runInTenantScope() + withTenantDb() so Postgres RLS policies enforce tenant isolation at the DB layer.

---

### Invariant: Generated asset serving never leaks access policy via HTTP status

<!-- entities: GeneratedAsset -->
<!-- enforced: route.ts:GET() /api/v1/assets/[assetId] → serveGeneratedAsset() -->

GET /api/v1/assets/[assetId] catches both GeneratedAssetNotFoundError and GeneratedAssetForbiddenError and returns 404 for both. No 403 Forbidden is ever returned, preventing attackers from enumerating which assets exist by comparing 403 vs 404 responses.

---

### Invariant: Chat stream response is never cached

<!-- entities: Response, StreamEvent -->
<!-- enforced: route.ts:POST() /api/v1/chat/stream response headers -->

POST /api/v1/chat/stream response headers include "cache-control": "no-cache", "connection": "keep-alive", ensuring SSE stream is not cached by any intermediate proxy or browser so every client sees live, current-session replies.

---

### Invariant: Generated asset serving is never cached

<!-- entities: GeneratedAsset, BlobStorage -->
<!-- enforced: route.ts:GET() /api/v1/assets/[assetId] response headers -->

GET /api/v1/assets/[assetId] response headers include "cache-control": "private, max-age=0, must-revalidate", ensuring no stale asset from a previous session is served to the current session.

---

### Invariant: Server-side key derivation prevents avatar path traversal

<!-- entities: User, BlobStorage -->
<!-- enforced: deriveAssetKey("avatar", session.user.id, ext) in route.ts:POST() /api/v1/upload/avatar -->

POST /api/v1/upload/avatar never accepts a client-supplied path or key for blob storage. The storage key is always derived server-side from user id + randomUUID, so a malicious client cannot upload to another user's storage path or traverse the object store.

---

### Invariant: Conversation asset listing invokes capability for metering and IAM

<!-- entities: Conversation, GeneratedAsset, CapabilityContext -->
<!-- enforced: invoke("conversation.files.list", …, capabilityCtx, { surface: "api" }) in route.ts:GET() /api/v1/conversations/[conversationId]/assets -->

GET /api/v1/conversations/[conversationId]/assets does NOT duplicate SQL from the capability handler. It resolves org/workspace server-side, verifies org membership, then invokes conversation.files.list through the kernel. This ensures metering, IAM role checks, and any capability-level RLS all flow through a single code path.

---

### Invariant: MCP manager role gates OAuth initiation and token exchange setup

<!-- entities: Organization, User, OAuthState -->
<!-- enforced: assertMcpManager(tenant.id, session.user.id) in authorize/route.ts:GET(), DbOAuthClientProvider state storage in authorize/route.ts:GET() -->

GET /api/v1/mcp/oauth/authorize requires owner/admin role via assertMcpManager(). Only then is OAuth state generated and stored. GET /api/v1/mcp/oauth/callback does not check role (it is an authorization server callback, not user-initiated), but the state lookup retrieves orgId/workspaceId + returnTo that were set by authorize, ensuring callback cannot be exploited to create a server install for a workspace the initiating user does not manage.

---

### Invariant: MCP server install upsert is idempotent

<!-- entities: McpServer, PluginInstalledPlugin -->
<!-- enforced: ON CONFLICT (workspaceId, orgListingId) DO UPDATE in callback/route.ts:GET() INSERT schema.mcpServers -->
<!-- verified_by: mcp_servers_ws_listing_uniq PARTIAL unique index, targetWhere: sql`org_listing_id IS NOT NULL` -->

callback/route.ts:GET() upserts mcpServers with ON CONFLICT (workspaceId, orgListingId) DO UPDATE so concurrent reconnect flows are safe: if the row exists, healthStatus/enabled are refreshed to healthy/true; if new, the row is created. The partial unique index mcp_servers_ws_listing_uniq (WHERE org_listing_id IS NOT NULL) ensures the conflict clause only matches OAuth installs, not other mcpServers kinds.

---

### Invariant: Page form fill is request-scoped and payload-bounded

<!-- entities: PageContext, FormField, Message -->
<!-- enforced: pageContext validation in route.ts:POST() /api/v1/chat/stream (BodySchema), page_form_fill tool registration conditional on pageContext.fillableForm -->

POST /api/v1/chat/stream accepts pageContext with fillableForm only when: fields array ≤60 entries, each field name/label ≤256 chars, formId/title ≤256 chars, entitySummary ≤500 chars, route ≤2048 chars. page_form_fill tool is registered only if fillableForm is non-null, scoped to the single request. Tool calls form.fill invoke which handles downstream validation. System prompt appends form metadata only when fillableForm non-null, educating the model to ask clarifying questions if ambiguous (never invent values).

---

### Invariant: Reasoning effort is only forwarded to models that support reasoning

<!-- entities: Model, ReasoningModel -->
<!-- enforced: supportsReasoning(modelIdOf(turnModel)) check in route.ts:POST() /api/v1/chat/stream -->

POST /api/v1/chat/stream accepts effort enum [low, medium, high] but only forwards it to streamAgentReply if supportsReasoning(modelIdOf(turnModel)) is true. A stray effort parameter for a non-reasoning model is silently dropped, preventing invalid requests to the LLM provider.

---

### Invariant: Payment checkout URLs use env var to support domain migration

<!-- entities: BillingSubscription, StripeCheckout -->
<!-- enforced: NEXT_PUBLIC_APP_URL env var in route.ts:POST() /api/v1/stripe/checkout -->

POST /api/v1/stripe/checkout constructs successUrl/cancelUrl using NEXT_PUBLIC_APP_URL environment variable, not hard-coded domain. This allows staging/prod environments to switch domains (oxagen.ai cutover) by changing env, without code changes or redeploy.

---

### Invariant: Conversation message history is deterministically ordered by createdAt

<!-- entities: Message, Conversation -->
<!-- enforced: DESC createdAt + LIMIT + reverse in route.ts:POST() /api/v1/chat/stream -->

POST /api/v1/chat/stream fetches up to 50 most-recent messages with DESC createdAt + LIMIT, then reverses in JS so the model sees chronological order (oldest → newest). This ensures every turn has the same history context (no drift due to insertion timing), preventing the model from hallucinating different prior turns on a page refresh.

---

### Invariant: Conversation active leaf is advanced after assistant reply persists

<!-- entities: Conversation, Message -->
<!-- enforced: schema.conversations.activeLeafMessageId update in route.ts:POST() /api/v1/chat/stream -->

POST /api/v1/chat/stream persists the assistant reply to messages, then updates conversation.activeLeafMessageId to the new message id. This ensures the next turn threads from the assistant's reply, not a stale/deleted branch. The update happens inside the same runInTenantScope/withTenantDb transaction so the state is atomic.

---

### Invariant: Fire-and-forget operations cannot break the user's chat turn

<!-- entities: Conversation, Message, Title, Job -->
<!-- enforced: fire-and-forget in autoTitleConversation() and best-effort error swallowing in route.ts:POST() /api/v1/chat/stream -->

POST /api/v1/chat/stream wraps assistant-reply persistence in try/catch; if DB fails, the error is logged but does NOT corrupt the SSE response the client already consumed. autoTitleConversation() is fire-and-forget (void return) so any model/DB error is swallowed; title generation failure never blocks or delays the chat turn.

---

<!-- uncertainty: Media generation fully specified in streamMediaGeneration helper (image synchronous via generateImageFor, video asynchronous via pending asset + Inngest dispatch); full event flow, error handling, and component rendering logic live in the helper. The route handler does not specify model selection fallback chains (basic vs advanced tier → default env vars) — those are in generateImageFor/videoTierModelId. Image placeholder rendering on model error is specified; video polling mechanism is not (client-side behavior). -->

<!-- uncertainty: MCP OAuth authorize/callback use DbOAuthClientProvider (from @oxagen/plugins) to manage PKCE state + OAuth flow with the MCP SDK's mcpAuth function. The state storage mechanism (ephemeral vs durable, timeout duration) and token encryption are not specified in these route handlers — they are delegated to DbOAuthClientProvider and @oxagen/plugins. The safeFetch wrapper works around Next.js fetch behavior (per-URL dedup locks, Response.body.cancel() hangs) but does not specify why the deadlock occurs or when it was introduced. -->

<!-- uncertainty: Message persistence is marked best-effort but the code does not specify recovery semantics. If persistence throws, the turn is not retried and the client is not informed (error is only logged). The model result has already been streamed; a retry would re-run the model. This is a design choice (favor immediate response + best-effort persistence) but not documented in a recovery plan or ticket. -->
