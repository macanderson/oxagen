# Spec: handlers-privacy-audit-web

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: privacy.data.export.ts, privacy.data.erase.ts, audit.log.query.ts, notifications.list.ts, notifications.mark.ts, web.fetch.ts, web.search.ts, prompt.settings.read.ts, prompt.settings.write.ts
> Last verified: 2026-06-20 (commit 2f628504)

Behavioral specs for privacy/GDPR handlers (data export, data erasure), audit-log query, notifications list/mark, web fetch/search (SSRF protections), and workspace-scoped prompt settings (read/write with enterprise tier gating).

---

### Requirement: User or org-scoped data export request

<!-- id: privacyDataExportHandler.execute -->
<!-- entities: User, Organization, PrivacyExportRequest -->
<!-- enforced: privacyDataExportHandler() -->
<!-- test: (pending) -->

User or organization owner requests a machine-readable data export (GDPR Article 20 — right to data portability). The handler creates a queued export request and dispatches an async Inngest job for ZIP assembly. The request is immediately returned with a public ID and status "queued".

#### Scenario: User-scope export with authentication
<!-- test: (pending) -->
- **WHEN** an authenticated user calls privacy.data.export with scope="user"
- **THEN** create privacyExportRequests record with userId=ctx.userId, scope="user", status="queued", and a unique public ID; emit security event with eventType="privacy.export_requested" and outcome="success"; dispatch privacy/export.process Inngest job with exportId and scope; return {exportId, status="queued"}

#### Scenario: Org-scope export by owner
<!-- test: (pending) -->
- **WHEN** an authenticated org Owner calls privacy.data.export with scope="org" and orgId
- **THEN** create privacyExportRequests record with orgId, scope="org", status="queued"; emit security event; dispatch job; return {exportId, status="queued"}

#### Scenario: User lacks authentication
<!-- test: (pending) -->
- **WHEN** userId is absent in context
- **THEN** throw error "Unauthorized: authentication required to request a data export"

#### Scenario: Org context missing
<!-- test: (pending) -->
- **WHEN** orgId is absent in context
- **THEN** throw error "Forbidden: orgId is required"

#### Scenario: Org scope without explicit orgId
<!-- test: (pending) -->
- **WHEN** scope="org" and orgId is not provided
- **THEN** throw error "orgId is required for org-scope export"

---

### Requirement: User or org-scoped data erasure with grace period

<!-- id: privacyDataEraseHandler.execute -->
<!-- entities: User, Organization, PrivacyErasureRequest, Session -->
<!-- enforced: privacyDataEraseHandler() -->
<!-- test: (pending) -->

User or organization owner requests complete data erasure (GDPR Article 17 — right to erasure). The handler enforces owner-only access for org scope, revokes all sessions immediately, schedules hard-delete via async Inngest job with grace period, and emits security events.

#### Scenario: User-scope erasure with confirmation
<!-- test: (pending) -->
- **WHEN** an authenticated user calls privacy.data.erase with scope="user" and confirm=true
- **THEN** create privacyErasureRequests record with scope="user", status="queued", scheduledAt=now+gracePeriod (default 30 days); immediately delete all sessions for this userId; emit security event with eventType="privacy.erasure_requested"; dispatch privacy/erasure.execute Inngest job; return {requestId, status="queued", effectiveAt=ISO8601 timestamp}

#### Scenario: Org-scope erasure by owner only
<!-- test: (pending) -->
- **WHEN** an authenticated org Owner calls privacy.data.erase with scope="org", orgId, and confirm=true
- **THEN** verify user has role="Owner" in orgUsers; create privacyErasureRequests record with scope="org"; revoke all sessions for this user immediately; emit security event with eventType="privacy.org_erasure_requested"; dispatch job with scope; return {requestId, status="queued", effectiveAt}

#### Scenario: Non-owner attempts org erasure
<!-- test: (pending) -->
- **WHEN** non-Owner org member calls privacy.data.erase with scope="org"
- **THEN** throw error "Forbidden: org erasure requires Owner role"

#### Scenario: User lacks authentication
<!-- test: (pending) -->
- **WHEN** userId is absent
- **THEN** throw error "Unauthorized: authentication required to request data erasure"

#### Scenario: Grace period configuration
<!-- test: (pending) -->
- **WHEN** PRIVACY_ERASURE_GRACE_DAYS environment variable is set
- **THEN** scheduledAt = now + (parseInt(PRIVACY_ERASURE_GRACE_DAYS, 10) * 24 * 60 * 60 * 1000); enforce minimum of 0; default is 30 days

#### Scenario: Missing confirmation
<!-- test: (pending) -->
- **WHEN** confirm is not literally true
- **THEN** contract-level validation rejects the request (Zod schema enforces confirm=literal(true))

---

### Invariant: Privacy events are recorded as security events

<!-- entities: User, Organization, PrivacyExportRequest, PrivacyErasureRequest -->
<!-- enforced: privacyDataExportHandler(), privacyDataEraseHandler() -->
<!-- verified_by: (pending) -->

Every privacy.data.export and privacy.data.erase request MUST emit a security event with the correct eventType, actorUserId, orgId, workspaceId, capability, and outcome. The outcome is always "success" when the request queues (handler completes without error).

> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Org-wide audit-log query with multi-spine merge

<!-- id: auditLogQueryHandler.execute -->
<!-- entities: SecurityEvent, PlaybookEvent, Organization -->
<!-- enforced: auditLogQueryHandler() -->
<!-- test: auditLogQueryHandler.test.ts -->

Admins and org owners query security and automation audit events (security_events and playbook_events) with flexible filters (actor, capability, outcome, time range, workspace) returning a unified, time-ordered feed. Results are merged newest-first across two heterogeneous tables.

#### Scenario: Query all events org-wide
<!-- test: auditLogQueryHandler.test.ts (merges security + playbook events newest-first and reports pagination) -->
- **WHEN** org admin calls audit.log.query with source="all", no filters
- **THEN** query security_events and playbook_events, both filtered by ctx.orgId; merge all rows by occurredAt DESC; return paginated results with events array (newest first), total (page size), hasMore (boolean), limit, offset

#### Scenario: Query security spine only
<!-- test: auditLogQueryHandler.test.ts (only queries the security spine when source=security) -->
- **WHEN** source="security"
- **THEN** query security_events table only; apply orgId filter + optional workspaceId, eventType, actorUserId, capability, outcome filters; return security events only

#### Scenario: Query playbook spine only
<!-- test: (pending) -->
- **WHEN** source="playbook"
- **THEN** query playbook_events table only; apply orgId filter + optional workspaceId, eventType, playbookRunId filters; return playbook events only

#### Scenario: Filter by time range
<!-- test: (pending) -->
- **WHEN** from and/or to are provided
- **THEN** apply gte(occurredAt, from_date) and/or lt(occurredAt, to_date) to both spines; return only events in [from, to)

#### Scenario: Workspace-scoped query
<!-- test: (pending) -->
- **WHEN** workspaceId is provided
- **THEN** add eq(workspaceId, input.workspaceId) to both table queries; restrict results to one workspace only

#### Scenario: Pagination with hasMore detection
<!-- test: auditLogQueryHandler.test.ts (reports hasMore when more events exist than the page window) -->
- **WHEN** offset=0, limit=50, but 100 matching events exist
- **THEN** over-fetch (offset + limit + 1) from each spine; merge and slice [offset, offset+limit]; set hasMore=true if merged length > offset+limit

#### Scenario: Tenant isolation enforcement
<!-- test: auditLogQueryHandler.test.ts (always scopes by orgId — tenant-isolation guard) -->
- **WHEN** audit.log.query is invoked with any input
- **THEN** ALWAYS apply eq(orgId, ctx.orgId) filter to both security_events and playbook_events; absence of orgId filter is a SOC 2 §0 breach

---

### Invariant: Audit queries always filter by orgId

<!-- entities: SecurityEvent, PlaybookEvent, Organization -->
<!-- enforced: auditLogQueryHandler() -->
<!-- verified_by: auditLogQueryHandler.test.ts (always scopes by orgId) -->

EVERY audit.log.query execution MUST include an explicit orgId filter on both security_events and playbook_events tables. A missing orgId filter would leak another tenant's audit trail and is a SOC 2 §0 violation. This is non-negotiable: the handler code must construct the WHERE condition with eq(schema.securityEvents.orgId, orgId) and eq(schema.playbookEvents.orgId, orgId).

> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: User-scoped notification list with unread count

<!-- id: handler.execute -->
<!-- entities: User, Organization, Notification -->
<!-- enforced: handler() (notifications.list.ts) -->
<!-- test: notifications.list.test.ts -->

User queries their in-app notifications filtered by read state, archived flag, and pagination. The response includes a parallel unreadCount (count of unread, non-archived notifications for this user+org).

#### Scenario: List unread notifications only
<!-- test: (pending) -->
- **WHEN** user calls notifications.list with unreadOnly=true, limit=50
- **THEN** query notifications table with userId, orgId, archived=false, unread=true; return notifications array ordered by createdAt DESC; compute unreadCount = count of unread+non-archived notifications; return {notifications, unreadCount}

#### Scenario: List all non-archived notifications
<!-- test: notifications.list.test.ts (returns notifications and unreadCount) -->
- **WHEN** unreadOnly=false
- **THEN** query notifications table with userId, orgId, archived=false (all read states); return ordered list; compute unreadCount separately; return both

#### Scenario: Pagination limit enforcement
<!-- test: (pending) -->
- **WHEN** limit=10
- **THEN** return at most 10 notifications; order by createdAt DESC; do not attempt to track hasMore (cursor-free, offset-based pagination assumed by contract)

#### Scenario: User not authenticated
<!-- test: notifications.list.test.ts (throws when userId is absent) -->
- **WHEN** userId is null in context
- **THEN** throw error "[notifications.list] userId is required (user-scoped)"

#### Scenario: Org context missing
<!-- test: (pending) -->
- **WHEN** orgId is null in context
- **THEN** throw error "[notifications.list] orgId is required (org-scoped)"

---

### Invariant: Notification queries scope to user and org

<!-- entities: User, Organization, Notification -->
<!-- enforced: handler() (notifications.list.ts) -->
<!-- verified_by: (pending) -->

EVERY notifications.list query MUST filter by both userId and orgId. Results MUST include only non-archived notifications (archived=false) for that user in that org. The unreadCount is always a separate query that also filters by these two keys plus unread=true and archived=false.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Mark notification as read and/or archived

<!-- id: handler.execute -->
<!-- entities: User, Organization, Notification -->
<!-- enforced: handler() (notifications.mark.ts) -->
<!-- test: notifications.mark.test.ts -->

User marks a notification (by publicId) as read and/or archived. The operation is a partial update: omitted fields are unchanged; null or boolean values are applied. updatedAt is always set to now.

#### Scenario: Mark as read
<!-- test: notifications.mark.test.ts (returns ok:true when marking as read) -->
- **WHEN** read=true is provided
- **THEN** set unread=false in the update; set updatedAt=now; execute update WHERE publicId=id AND userId=ctx.userId AND orgId=ctx.orgId; return {ok:true}

#### Scenario: Mark as archived
<!-- test: notifications.mark.test.ts (returns ok:true when archiving) -->
- **WHEN** archived=true is provided
- **THEN** set archived=true in the update; set updatedAt=now; execute update; return {ok:true}

#### Scenario: Unmark as read
<!-- test: (pending) -->
- **WHEN** read=false
- **THEN** set unread=true; update; return {ok:true}

#### Scenario: Unmark as archived
<!-- test: (pending) -->
- **WHEN** archived=false
- **THEN** set archived=false; update; return {ok:true}

#### Scenario: No-op: no fields provided
<!-- test: notifications.mark.test.ts (returns ok:true with no-op when neither read nor archived provided) -->
- **WHEN** neither read nor archived is provided (both undefined)
- **THEN** only updatedAt would be set; return {ok:true} without executing an update

#### Scenario: User not authenticated
<!-- test: notifications.mark.test.ts (throws when userId is absent) -->
- **WHEN** userId is null
- **THEN** throw error "[notifications.mark] userId is required (user-scoped)"

#### Scenario: User attempts to mark someone else's notification
<!-- test: (pending) -->
- **WHEN** publicId belongs to a different user
- **THEN** WHERE clause filters by userId=ctx.userId; update silently affects zero rows; return {ok:true}

---

### Invariant: Notification mutations scope to user and org

<!-- entities: User, Organization, Notification -->
<!-- enforced: handler() (notifications.mark.ts) -->
<!-- verified_by: notifications.mark.test.ts -->

EVERY notifications.mark update MUST include WHERE conditions: publicId=id AND userId=ctx.userId AND orgId=ctx.orgId. Users may only modify their own notifications within their org. updatedAt MUST be set to now.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Web fetch with SSRF protection and content extraction

<!-- id: webFetchHandler.execute -->
<!-- entities: URL, HTTPResponse -->
<!-- enforced: webFetchHandler() -->
<!-- test: web.fetch.test.ts -->

Fetch a URL and optionally extract clean markdown content. The handler enforces strict SSRF protection: only http:// and https:// schemes are allowed. Content extraction removes script, style, nav, footer, header blocks and converts HTML to readable markdown.

#### Scenario: Fetch with markdown extraction (default)
<!-- test: web.fetch.test.ts (returns result matching the contract output shape) -->
- **WHEN** user calls web.fetch with url="https://example.com", extractMarkdown=true (default), timeout=10000 (default)
- **THEN** validate URL scheme is http:// or https://; set AbortController timeout; fetch with User-Agent and Accept headers; parse response.text(); extract markdown via extractMarkdownFromHtml(); return {url, title, content (markdown), wordCount, fetchedAt (ISO8601), statusCode}

#### Scenario: Fetch raw HTML without extraction
<!-- test: web.fetch.test.ts (passes extractMarkdown=false through to webFetch) -->
- **WHEN** extractMarkdown=false
- **THEN** fetch URL; return response.text() as-is (raw HTML); wordCount counted from raw text; title=""; return {url, title="", content (HTML), wordCount, fetchedAt, statusCode}

#### Scenario: Scheme validation rejects non-http(s)
<!-- test: web.fetch.test.ts (propagates scheme validation errors) -->
- **WHEN** url="ftp://example.com/file" or any non-http(s) scheme
- **THEN** throw error: "web.fetch: URL scheme \"<scheme>:\" is not allowed — only http:// and https:// are supported"

#### Scenario: Timeout enforcement
<!-- test: web.fetch.test.ts (propagates timeout errors) -->
- **WHEN** fetch request exceeds timeout (e.g., 10000ms)
- **THEN** AbortController.signal aborts; catch AbortError; throw error: "web.fetch: request timed out after <timeout>ms for URL \"<url>\""

#### Scenario: Invalid URL format
<!-- test: (pending) -->
- **WHEN** url is malformed (e.g., "ht!tp://bad")
- **THEN** new URL(options.url) throws; catch and throw: "web.fetch: invalid URL \"<url>\""

---

### Invariant: HTML stripping removes dangerous blocks

<!-- entities: URL, HTMLContent -->
<!-- enforced: extractMarkdownFromHtml() -->
<!-- verified_by: web.fetch.test.ts (HTML stripping suite) -->

The extractMarkdownFromHtml function MUST remove entire <script>, <style>, <nav>, <footer>, and <header> blocks (content and tags) before processing. This prevents XSS and obfuscated content injection. All remaining HTML tags are then stripped, leaving only text and markdown-converted elements.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Only http and https schemes allowed

<!-- entities: URL, HTTPRequest -->
<!-- enforced: webFetchHandler() -->
<!-- verified_by: web.fetch.test.ts (scheme validation) -->

EVERY web.fetch request MUST validate that the URL scheme is http:// or https:// before any network call. SSRF attacks (file://, gopher://, data:, etc.) are blocked at the scheme check. No exceptions.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Web search with domain filtering and result mapping

<!-- id: webSearchHandler.execute -->
<!-- entities: SearchQuery, SearchResult, Domain -->
<!-- enforced: webSearchHandler() -->
<!-- test: web.search.test.ts -->

User queries the web (via Tavily API) with optional domain inclusion/exclusion filters and search-depth control. The handler forwards parameters and maps Tavily results to the contract output shape.

#### Scenario: Basic web search with defaults
<!-- test: web.search.test.ts (returns mapped results matching the contract output shape) -->
- **WHEN** user calls web.search with query="example query", maxResults defaults to 5, searchDepth defaults to "basic"
- **THEN** call webSearch({query, maxResults: 5, searchDepth: "basic", includeDomains: undefined, excludeDomains: undefined}); map Tavily results array to {results: [{title, url, content, score, publishedDate?}, ...], totalResults: count, searchId: unique_id}

#### Scenario: Advanced search with domain filters
<!-- test: web.search.test.ts (forwards includeDomains and excludeDomains to webSearch) -->
- **WHEN** includeDomains=["github.com"], excludeDomains=["twitter.com"], searchDepth="advanced"
- **THEN** forward all three to webSearch(); return filtered and deep-searched results

#### Scenario: Empty results
<!-- test: web.search.test.ts (returns empty results without error) -->
- **WHEN** query matches no pages
- **THEN** return {results: [], totalResults: 0, searchId: unique_id}

#### Scenario: Missing Tavily API key
<!-- test: web.search.test.ts (propagates errors from webSearch — missing API key) -->
- **WHEN** TAVILY_API_KEY environment variable is not set
- **THEN** webSearch() throws; propagate error: "web.search: TAVILY_API_KEY environment variable is required but not set"

---

### Requirement: Workspace-scoped prompt settings read

<!-- id: promptSettingsReadHandler.execute -->
<!-- entities: Workspace, PromptConfig, AdditionalInstructions, Overrides, AutoImprovePrompts -->
<!-- enforced: promptSettingsReadHandler() -->
<!-- test: prompt.settings.read.test.ts -->

Read workspace prompt configuration (additional instructions, model-specific overrides, auto-improve flag). The handler loads the config from workspace.workspaces.settings.promptConfig, normalizes it, and applies defaults (autoImprovePrompts=ON, overrides={} if unset).

#### Scenario: Read prompt config from workspace
<!-- test: prompt.settings.read.test.ts (returns stored config) -->
- **WHEN** user calls prompt.settings.read with workspace context
- **THEN** call loadWorkspacePromptConfig(ctx.workspaceId); normalize untrusted JSONB; return {additionalInstructions: string | null, overrides: Record<string, string>, autoImprovePrompts: boolean}

#### Scenario: Default autoImprovePrompts to ON
<!-- test: prompt.settings.read.test.ts (defaults autoImprovePrompts to ON) -->
- **WHEN** workspace has no promptConfig or autoImprovePrompts is unset
- **THEN** return autoImprovePrompts=true (default ON; beta prompt-enhancement judge is enabled unless explicitly turned off)

#### Scenario: Default overrides to empty object
<!-- test: prompt.settings.read.test.ts (defaults ... overrides to {} when unset) -->
- **WHEN** overrides key is absent or null
- **THEN** return overrides={}

#### Scenario: No workspace context
<!-- test: prompt.settings.read.test.ts (throws without a workspace context) -->
- **WHEN** workspaceId is null or absent
- **THEN** throw error: "prompt.settings.read requires a workspace context"

---

### Requirement: Workspace-scoped prompt settings write with enterprise tier gating

<!-- id: promptSettingsWriteHandler.execute -->
<!-- entities: Workspace, PromptConfig, Organization, Tier -->
<!-- enforced: promptSettingsWriteHandler() -->
<!-- test: prompt.settings.write.test.ts -->

Partial update of workspace prompt configuration. additionalInstructions and autoImprovePrompts are available on all tiers. Full prompt override (overrides key with non-empty value) requires ENTERPRISE tier; requireTier throws TierDeniedError on non-enterprise tiers. The handler reads, merges, and writes workspace.settings.promptConfig to preserve other settings keys.

#### Scenario: Write additional instructions (all tiers)
<!-- test: prompt.settings.write.test.ts (writes additionalInstructions on any tier) -->
- **WHEN** user calls prompt.settings.write with additionalInstructions="Be formal." (no overrides)
- **THEN** no tier check is performed; read workspace.workspaces.settings; read-merge-write promptConfig with new additionalInstructions; preserve other settings keys; return new config; no TierDeniedError

#### Scenario: Write auto-improve toggle (all tiers)
<!-- test: (pending) -->
- **WHEN** autoImprovePrompts=false (or true)
- **THEN** no tier gate; update promptConfig.autoImprovePrompts; return new config

#### Scenario: Write overrides (enterprise only)
<!-- test: prompt.settings.write.test.ts (enforces the enterprise tier gate when overrides are provided) -->
- **WHEN** overrides={...} (non-empty object)
- **THEN** check org tier via resolveOrgTier(ctx.orgId); call requireTier(tier, "enterprise", "prompt-overrides"); if tier < enterprise, requireTier throws TierDeniedError; update workspace promptConfig.overrides; return new config

#### Scenario: Non-enterprise org attempts overrides
<!-- test: prompt.settings.write.test.ts (rejects overrides below enterprise) -->
- **WHEN** tier is "build" or below, and overrides are provided
- **THEN** requireTier() throws TierDeniedError; no update executes; propagate error to caller

#### Scenario: Clear overrides with null
<!-- test: (pending) -->
- **WHEN** overrides=null
- **THEN** check tier only if overrides was previously non-empty; set overrides=null in config to clear them

#### Scenario: Merge-write preserves other settings
<!-- test: prompt.settings.write.test.ts (merges into existing promptConfig, preserving other settings keys) -->
- **WHEN** workspace.settings already contains {theme: "dark", promptConfig: {...}}
- **THEN** read existing settings; read existing promptConfig; apply partial update (undefined = skip, null = clear, value = set); write back settings with both theme and updated promptConfig; return updated promptConfig only

#### Scenario: No workspace context
<!-- test: prompt.settings.write.test.ts (throws without a workspace context) -->
- **WHEN** workspaceId is null
- **THEN** throw error: "prompt.settings.write requires a workspace context"

#### Scenario: Undefined fields left unchanged
<!-- test: (pending) -->
- **WHEN** additionalInstructions is undefined (not provided)
- **THEN** leave workspace's existing additionalInstructions value unchanged (do not overwrite with undefined)

---

### Invariant: Prompt overrides require enterprise tier

<!-- entities: Organization, Workspace, PromptConfig, Tier -->
<!-- enforced: promptSettingsWriteHandler() -->
<!-- verified_by: prompt.settings.write.test.ts (enforces the enterprise tier gate) -->

EVERY non-empty overrides update (overrides key with object containing at least one key-value pair) MUST gate on organization tier and reject if tier < "enterprise". The requireTier() call throws TierDeniedError if the check fails, preventing the update from executing.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Prompt config read-merge-write preserves other settings

<!-- entities: Workspace, Settings, PromptConfig -->
<!-- enforced: promptSettingsWriteHandler() -->
<!-- verified_by: prompt.settings.write.test.ts (merges into existing promptConfig) -->

EVERY prompt settings write operation MUST read workspace.settings (the full settings JSONB bag), locate or initialize promptConfig, apply the partial update, and write back the entire settings object with other keys preserved. This prevents accidental deletion of settings that share the same JSONB structure.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: privacy.data.export and privacy.data.erase lack unit tests in the codebase. The contracts define the input/output shapes and access control rules, and the handlers implement the queuing logic, but no test file was found. Behaviors are extracted from code analysis alone. -->

<!-- uncertainty: web.search handler does not validate or document the TAVILY_API_KEY check — it is delegated to the @oxagen/web package. Behavior is inferred from test comments and error propagation. -->
