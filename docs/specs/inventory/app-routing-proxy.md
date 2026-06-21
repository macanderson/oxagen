# Spec: app-routing-proxy

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: proxy.ts, resolve-org.ts, session.ts, scope.ts, routes.ts, resolve-active-tab.ts, sidebar.ts, sidebar-item-affordance.ts
> Last verified: 2026-06-20 (commit 2f628504)

## Description

Request routing, tenant resolution, and navigation configuration for the Next.js 16 App Router frontend. Covers the edge proxy that intercepts and redirects requests before route rendering, the server-side org/workspace slug resolution layer, session validation, sidebar mode derivation, active tab calculation, and route path builders for the three-tier navigation model (account, org, workspace).

---

### Requirement: Session-gated auth boundary for page routes

<!-- id: proxy.hasSession -->
<!-- entities: Session, Cookie -->
<!-- enforced: proxy.hasSession() -->

The proxy SHALL block unauthenticated access to all page routes except designated public paths. Any request to a page route without a valid session cookie SHALL be redirected to `/login`. The session cookie name pattern matches `*.session_token` (with optional `__Secure-` HTTPS prefix from Better Auth). PUBLIC_PATHS (`/login`, `/signup`, `/verify`) are exempt from this check and bypass the redirect.

#### Scenario: authenticated user accessing a protected page
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to a page route includes a valid `session_token` cookie
- **THEN** the request proceeds to route rendering (`NextResponse.next()`)

#### Scenario: unauthenticated user accessing a protected page
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to a page route has no `session_token` cookie or the cookie value is empty
- **THEN** the request is redirected to `/login` (HTTP 307 temporary redirect)

#### Scenario: public paths are always reachable
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/login`, `/signup`, or `/verify` (exact or with trailing slash) is made
- **THEN** the request proceeds without session validation

---

### Requirement: Permanent redirect of pre-rename onboarding entrypoint

<!-- id: proxy.onboarding-redirect -->
<!-- entities: URL -->
<!-- enforced: proxy() -->

The old onboarding URL path `/new-tenant` (and all sub-paths `/new-tenant/...`) SHALL be permanently redirected to `/new-organization` with HTTP 308 (permanent, method-preserving). Query parameters are preserved in the redirect.

#### Scenario: root onboarding URL redirect
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/new-tenant` is made
- **THEN** a 308 redirect to `/new-organization` is returned

#### Scenario: onboarding sub-path redirect
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/new-tenant/step-two` is made
- **THEN** a 308 redirect to `/new-organization/step-two` is returned

#### Scenario: query parameters preserved in onboarding redirect
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/new-tenant?param=value` is made
- **THEN** a 308 redirect to `/new-organization?param=value` is returned

---

### Requirement: Workspace route renames and IA realignment

<!-- id: proxy.ws-route-moves -->
<!-- entities: URL, WorkspaceRoute -->
<!-- enforced: proxy() -->

Within a workspace scope (`/{org}/{ws}/`), several legacy route names are permanently redirected to new locations per IA spec §16. The redirect order matters: specific rules (`agents/runs`) precede general rules (`agents`). HTTP 301 (permanent, GET-preserving) is used per spec. Query parameters are preserved.

#### Scenario: agents/runs moves to activity/runs
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/{org}/{ws}/agents/runs` or `/{org}/{ws}/agents/runs/{fanoutId}` is made
- **THEN** a 301 redirect to `/{org}/{ws}/activity/runs` or `/{org}/{ws}/activity/runs/{fanoutId}` is returned

#### Scenario: workflows moves to activity/runs
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/{org}/{ws}/workflows` or `/{org}/{ws}/workflows/...` is made
- **THEN** a 301 redirect to `/{org}/{ws}/activity/runs` is returned (no sub-path preserved)

#### Scenario: executions moves to activity/runs
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/{org}/{ws}/executions` or `/{org}/{ws}/executions/{id}` is made
- **THEN** a 301 redirect to `/{org}/{ws}/activity/runs` or `/{org}/{ws}/activity/runs/{id}` is returned

#### Scenario: agents moves to automation/agents
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/{org}/{ws}/agents` or `/{org}/{ws}/agents/{slug}` is made (not matching agents/runs)
- **THEN** a 301 redirect to `/{org}/{ws}/automation/agents` or `/{org}/{ws}/automation/agents/{slug}` is returned

#### Scenario: playbooks moves to automation/playbooks
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/{org}/{ws}/playbooks` or `/{org}/{ws}/playbooks/...` is made
- **THEN** a 301 redirect to `/{org}/{ws}/automation/playbooks` or `/{org}/{ws}/automation/playbooks/...` is returned

#### Scenario: chat moves to ask
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/{org}/{ws}/chat` or `/{org}/{ws}/chat/...` is made
- **THEN** a 301 redirect to `/{org}/{ws}/ask` is returned (sub-path dropped)

---

### Requirement: Proxy runs only on page routes, not API

<!-- id: proxy.matcher -->
<!-- entities: Request -->
<!-- enforced: proxy.config.matcher -->

The proxy matcher SHALL execute on all page routes and exclude API routes, Next.js internals, and static assets. This ensures `/api/auth/*` remains publicly reachable to establish sessions, and other API routes enforce their own auth gates.

#### Scenario: proxy matches page routes
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/{org}/{ws}/ask` is made
- **THEN** the proxy matcher executes and checks session status

#### Scenario: proxy skips API routes
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/api/v1/foo` is made
- **THEN** the proxy matcher does not execute (route handler checks auth itself)

#### Scenario: proxy skips static assets
<!-- test: proxy.ts (no unit test; guarded by E2E coverage) -->
- **WHEN** a request to `/_next/static/...` or `favicon.ico` is made
- **THEN** the proxy matcher does not execute

---

### Requirement: Resolve organization by slug and cache per request

<!-- id: resolve-org.resolveOrg -->
<!-- entities: Organization, Slug -->
<!-- enforced: resolve-org.resolveOrg() -->

When a page component calls `resolveOrg(slug)`, the system SHALL query the organizations table for an exact slug match and return a ResolvedOrg object with mapped fields (id, publicId, name, slug). If no row exists, `notFound()` is called (HTTP 404). Per-request React `cache()` memoization ensures a single DB query even when multiple RSCs in the same render tree call `resolveOrg` with the same slug.

#### Scenario: successful org slug resolution
<!-- test: ResolvedOrg.test.ts.returns-ResolvedOrg-with-correct-mapped-fields -->
- **WHEN** `resolveOrg("acme")` is called and a row with slug="acme" exists
- **THEN** a ResolvedOrg object is returned with id, publicId, name, slug all populated

#### Scenario: org slug not found
<!-- test: ResolvedOrg.test.ts.calls-notFound-on-empty-query -->
- **WHEN** `resolveOrg("nonexistent")` is called and no row exists
- **THEN** `notFound()` is called, rendering a 404 page

#### Scenario: per-request memoization collapses duplicate slugs
<!-- test: ResolvedOrg.test.ts.uses-cache-to-memoize -->
- **WHEN** `resolveOrg("acme")` is called twice in the same React render tree
- **THEN** the DB query is executed only once; the second call returns the memoized result

---

### Requirement: Resolve workspace by org and workspace slug

<!-- id: resolve-org.resolveWorkspace -->
<!-- entities: Workspace, Organization, Slug -->
<!-- enforced: resolve-org.resolveWorkspace() -->

When a page component calls `resolveWorkspace(orgId, slug)`, the system SHALL query the workspaces table for a row matching BOTH orgId and slug, and return a ResolvedWorkspace object. The `description` field is extracted from the workspace settings JSONB bag (same key as written by `workspace.settings.write` handler). If no row exists, `notFound()` is called. Per-request memoization ensures a single DB query per unique (orgId, slug) pair.

#### Scenario: successful workspace resolution
<!-- test: resolve-org.test.ts.resolveWorkspace-returns-mapped-fields -->
- **WHEN** `resolveWorkspace(orgId, "default")` is called and a row exists
- **THEN** a ResolvedWorkspace object is returned with id, publicId, orgId, name, slug, description populated

#### Scenario: workspace not found returns 404
<!-- test: resolve-org.test.ts.resolveWorkspace-calls-notFound-on-empty -->
- **WHEN** `resolveWorkspace(orgId, "unknown")` is called and no row matches
- **THEN** `notFound()` is called

#### Scenario: workspace description extracted from settings JSONB
<!-- test: resolve-org.test.ts.resolveWorkspace-reads-description-from-settings -->
- **WHEN** `resolveWorkspace(orgId, slug)` is called for a workspace with settings.description="Main team space"
- **THEN** the returned ResolvedWorkspace.description equals "Main team space"

#### Scenario: missing or null description defaults to empty string
<!-- test: resolve-org.test.ts.resolveWorkspace-handles-missing-description -->
- **WHEN** `resolveWorkspace(orgId, slug)` is called for a workspace with no settings.description or invalid type
- **THEN** the returned ResolvedWorkspace.description equals ""

---

### Requirement: Assert user is an org member before org-scoped access

<!-- id: resolve-org.assertOrgMember -->
<!-- entities: User, Organization, OrgUsers -->
<!-- enforced: resolve-org.assertOrgMember() -->

When a page or API route calls `assertOrgMember(orgId, userId)`, the system SHALL query the org_users table for an (orgId, userId) row. If no row exists, `notFound()` (HTTP 404) is called. A non-member is treated identically to a non-existent org (404, not 403) to prevent IDOR information leakage. Per-request memoization ensures a single DB query per (orgId, userId) pair. This gate MUST be called after `resolveOrg()` in any server-side path that reads org-scoped data.

#### Scenario: org member access granted
<!-- test: resolve-org.test.ts.assertOrgMember-does-not-call-notFound-for-existing-member -->
- **WHEN** `assertOrgMember(orgId, userId)` is called and (orgId, userId) exists in org_users
- **THEN** the function returns without error

#### Scenario: non-member returns 404
<!-- test: resolve-org.test.ts.assertOrgMember-calls-notFound-for-non-member -->
- **WHEN** `assertOrgMember(orgId, userId)` is called and the pair does not exist in org_users
- **THEN** `notFound()` is called, hiding the org existence from the non-member

---

### Requirement: Assert user is a workspace member

<!-- id: resolve-org.assertWorkspaceMember -->
<!-- entities: User, Workspace, WorkspaceUsers -->
<!-- enforced: resolve-org.assertWorkspaceMember() -->

When a workspace layout (`[workspaceSlug]/layout.tsx`) calls `assertWorkspaceMember(workspaceId, userId)`, the system SHALL query the workspace_users table for an (workspaceId, userId) row. If no row exists, `notFound()` is called. A user scoped to workspace A cannot read workspace B, even within the same org. 404 (not 403) maintains information hiding. Per-request memoization ensures a single DB query per (workspaceId, userId) pair. This is the canonical enforcement point for workspace-scoped content.

#### Scenario: workspace member access granted
<!-- test: resolve-org.test.ts.assertWorkspaceMember-does-not-call-notFound-for-member -->
- **WHEN** `assertWorkspaceMember(workspaceId, userId)` is called and (workspaceId, userId) exists
- **THEN** the function returns without error

#### Scenario: non-member of workspace returns 404
<!-- test: resolve-org.test.ts.assertWorkspaceMember-calls-notFound-for-non-member -->
- **WHEN** `assertWorkspaceMember(workspaceId, userId)` is called and the pair does not exist
- **THEN** `notFound()` is called

---

### Requirement: Assert user holds plugin-manager role

<!-- id: resolve-org.assertMcpManager -->
<!-- entities: User, Organization, OrgUsers, Role -->
<!-- enforced: resolve-org.assertMcpManager() -->

When an org-level plugin management route (install, uninstall, denylist, registry, enable/disable) calls `assertMcpManager(orgId, userId)`, the system SHALL verify that the user is an org member AND holds one of the MCP_MANAGER_ROLES ("owner" or "admin"). If either condition fails, `notFound()` is called. This gate prevents non-managers from mutating org plugin governance.

#### Scenario: owner can manage plugins
<!-- test: resolve-org.test.ts.assertMcpManager-allows-owner-role -->
- **WHEN** `assertMcpManager(orgId, userId)` is called and the user holds "owner" role
- **THEN** the function returns without error

#### Scenario: admin can manage plugins
<!-- test: resolve-org.test.ts.assertMcpManager-allows-admin-role -->
- **WHEN** `assertMcpManager(orgId, userId)` is called and the user holds "admin" role
- **THEN** the function returns without error

#### Scenario: member without manager role cannot manage plugins
<!-- test: resolve-org.test.ts.assertMcpManager-calls-notFound-for-non-manager -->
- **WHEN** `assertMcpManager(orgId, userId)` is called and the user holds "member" role
- **THEN** `notFound()` is called

---

### Requirement: Assert user holds billing-manager role

<!-- id: resolve-org.assertBillingManager -->
<!-- entities: User, Organization, OrgUsers, Role, Billing -->
<!-- enforced: resolve-org.assertBillingManager() -->

When a billing mutation route (checkout, credit purchase, plan change) calls `assertBillingManager(orgId, userId)`, the system SHALL verify that the user is an org member AND holds one of the BILLING_MANAGER_ROLES ("owner", "admin", or "billing"). If either condition fails, `notFound()` is called. This gate prevents non-managers from spending the org's money. A non-manager is treated like a non-member (404) for consistency with `assertOrgMember`.

#### Scenario: owner can mutate billing
<!-- test: resolve-org.test.ts.assertBillingManager-allows-owner-role -->
- **WHEN** `assertBillingManager(orgId, userId)` is called and the user holds "owner" role
- **THEN** the function returns without error

#### Scenario: billing-role can mutate billing
<!-- test: resolve-org.test.ts.assertBillingManager-allows-billing-role -->
- **WHEN** `assertBillingManager(orgId, userId)` is called and the user holds "billing" role
- **THEN** the function returns without error

#### Scenario: member without billing role cannot mutate billing
<!-- test: resolve-org.test.ts.assertBillingManager-calls-notFound-for-non-manager -->
- **WHEN** `assertBillingManager(orgId, userId)` is called and the user holds "member" role
- **THEN** `notFound()` is called

---

### Requirement: Assert user holds security-manager role

<!-- id: resolve-org.assertSecurityManager -->
<!-- entities: User, Organization, OrgUsers, Role -->
<!-- enforced: resolve-org.assertSecurityManager() -->

When the signed audit-export endpoint calls `assertSecurityManager(orgId, userId)`, the system SHALL verify that the user is an org member AND holds one of the SECURITY_MANAGER_ROLES ("owner" or "admin"). If either condition fails, `notFound()` is called. This gate prevents non-managers from pulling the org's full audit trail.

#### Scenario: owner can export compliance evidence
<!-- test: resolve-org.test.ts.assertSecurityManager-allows-owner -->
- **WHEN** `assertSecurityManager(orgId, userId)` is called and the user holds "owner" role
- **THEN** the function returns without error

#### Scenario: non-manager cannot export compliance evidence
<!-- test: resolve-org.test.ts.assertSecurityManager-calls-notFound-for-non-manager -->
- **WHEN** `assertSecurityManager(orgId, userId)` is called and the user holds "member" role
- **THEN** `notFound()` is called

---

### Requirement: Resolve workspace scope (org + workspace membership in one query)

<!-- id: resolve-org.resolveWorkspaceScope -->
<!-- entities: Workspace, Organization, User, WorkspaceUsers -->
<!-- enforced: resolve-org.resolveWorkspaceScope() -->

When an API route or server action receives a `workspaceId` from the client (but NOT the org/workspace slugs), it calls `resolveWorkspaceScope(workspaceId, userId)` to resolve the workspace's owning org AND assert membership in a single query. The function returns `{ orgId, workspaceId }` on success or `null` when the workspace is unknown OR the user is not a member (the two are intentionally indistinguishable). A `null` result means the workspace-scoped capability should fail gracefully (no 404, no error cascade). Per-request memoization ensures a single DB query per (workspaceId, userId) pair. Never pass an empty/placeholder orgId into `invoke()` — the handler filter depends on a real org id.

#### Scenario: valid workspace scope resolved
<!-- test: resolve-org.test.ts.resolveWorkspaceScope-returns-both-ids -->
- **WHEN** `resolveWorkspaceScope(workspaceId, userId)` is called and the user is a member
- **THEN** `{ orgId, workspaceId }` is returned

#### Scenario: user not a member returns null
<!-- test: resolve-org.test.ts.resolveWorkspaceScope-returns-null-for-non-member -->
- **WHEN** `resolveWorkspaceScope(workspaceId, userId)` is called and the user is not a workspace member
- **THEN** `null` is returned (no exception)

#### Scenario: empty workspaceId returns null
<!-- test: resolve-org.test.ts.resolveWorkspaceScope-returns-null-for-empty-id -->
- **WHEN** `resolveWorkspaceScope("", userId)` is called with an empty workspaceId
- **THEN** `null` is returned

---

### Requirement: Get user's role in org for UI gating

<!-- id: resolve-org.getOrgRole -->
<!-- entities: User, Organization, OrgUsers, Role -->
<!-- enforced: resolve-org.getOrgRole() -->

When a component wants to conditionally render (e.g., enable/disable a button) based on the user's org role, it calls `getOrgRole(orgId, userId)`. The function returns the role string ("owner", "admin", "member", "billing") or `null` when the user is not a member. This is read-only and does NOT call `notFound()` — it is safe for UI gating. Per-request memoization ensures a single DB query per (orgId, userId) pair. For hard gates (route protection), use `assertOrgMember`, `assertBillingManager`, etc. instead.

#### Scenario: org member role retrieved
<!-- test: resolve-org.test.ts.getOrgRole-returns-role-for-member -->
- **WHEN** `getOrgRole(orgId, userId)` is called and the user is a member
- **THEN** the role string ("owner", "admin", "member", etc.) is returned

#### Scenario: non-member returns null without error
<!-- test: resolve-org.test.ts.getOrgRole-returns-null-for-non-member -->
- **WHEN** `getOrgRole(orgId, userId)` is called and the user is not a member
- **THEN** `null` is returned (no exception, no notFound)

---

### Requirement: Collapse session lookup to one DB query per request

<!-- id: session.getSession -->
<!-- entities: Session, User -->
<!-- enforced: session.getSession() -->

When multiple RSCs in the same render tree call `getSession()`, the system SHALL execute the Better Auth session lookup only once and memoize the result via React `cache()`. This avoids redundant DB hits across the request boundary.

#### Scenario: multiple RSCs share memoized session
<!-- test: session.test.ts.getSession-memoizes-per-request -->
- **WHEN** two RSCs both call `getSession()` in the same request
- **THEN** the session lookup is executed once; both calls return the same result

---

### Requirement: Get session or redirect to login

<!-- id: session.getSessionOrRedirect -->
<!-- entities: Session, User -->
<!-- enforced: session.getSessionOrRedirect() -->

When a server component needs to guarantee a user is authenticated before rendering, it calls `getSessionOrRedirect(redirectTo)`. If the session exists and has a user, it is returned. If not, `redirect()` is called with the target URL (default `/login`). This is a hard gate that halts component rendering.

#### Scenario: authenticated user returns session
<!-- test: session.test.ts.getSessionOrRedirect-returns-session-when-authenticated -->
- **WHEN** `getSessionOrRedirect()` is called and a valid session exists
- **THEN** the session object is returned

#### Scenario: unauthenticated user is redirected
<!-- test: session.test.ts.getSessionOrRedirect-redirects-when-not-authenticated -->
- **WHEN** `getSessionOrRedirect()` is called and no valid session exists
- **THEN** `redirect("/login")` is called

#### Scenario: custom redirect target
<!-- test: session.test.ts.getSessionOrRedirect-respects-custom-redirectTo -->
- **WHEN** `getSessionOrRedirect("/custom")` is called and no session exists
- **THEN** `redirect("/custom")` is called

---

### Requirement: Derive navigation mode from pathname and scope

<!-- id: sidebar.resolveSidebarMode -->
<!-- entities: URL, Scope -->
<!-- enforced: sidebar.resolveSidebarMode() -->

The sidebar mode (account, org, workspace) is derived from the pathname and ScopeContext. Rules are applied in order:
1. If pathname starts with `/account`, mode is "account"
2. If ctx.workspaceSlug is set, mode is "workspace" (fast-path)
3. If pathname is `/{org}/{segment}/...` where segment is NOT a reserved org-scope route, mode is "workspace"
4. Otherwise, mode is "org"

Reserved org-scope routes are: "members", "access", "security", "billing", "developer", "settings".

#### Scenario: account paths resolve to account mode
<!-- test: sidebar.test.ts.resolveSidebarMode-returns-account-for-account-paths -->
- **WHEN** `resolveSidebarMode("/account/profile", ctx)` is called
- **THEN** "account" is returned

#### Scenario: workspace context fast-path
<!-- test: sidebar.test.ts.resolveSidebarMode-returns-workspace-when-workspaceSlug-present -->
- **WHEN** `resolveSidebarMode("/path", { orgSlug: "acme", workspaceSlug: "ws1" })` is called
- **THEN** "workspace" is returned

#### Scenario: workspace derived from pathname
<!-- test: sidebar.test.ts.resolveSidebarMode-returns-workspace-from-pathname -->
- **WHEN** `resolveSidebarMode("/acme/ws1/ask", { orgSlug: "acme" })` is called (no workspaceSlug in ctx)
- **THEN** "workspace" is returned (ws1 is not a reserved route)

#### Scenario: reserved org-scope route blocks workspace mode
<!-- test: sidebar.test.ts.resolveSidebarMode-returns-org-for-reserved-org-routes -->
- **WHEN** `resolveSidebarMode("/acme/members", { orgSlug: "acme" })` is called
- **THEN** "org" is returned (members is reserved)

#### Scenario: org root path resolves to org mode
<!-- test: sidebar.test.ts.resolveSidebarMode-returns-org-when-no-workspaceSlug -->
- **WHEN** `resolveSidebarMode("/acme", { orgSlug: "acme" })` is called
- **THEN** "org" is returned

---

### Requirement: Recover workspace slug from URL for sidebar href resolution

<!-- id: sidebar.resolveSidebarCtx -->
<!-- entities: URL, Scope -->
<!-- enforced: sidebar.resolveSidebarCtx() -->

The org-level layout (`/[orgSlug]/layout.tsx`) mounts the shell without a workspaceSlug in the context (it has no access to that route param). When in workspace mode, sidebar items' `href()` functions would collapse to the org root if workspaceSlug is absent. `resolveSidebarCtx()` recovers the workspace slug from the pathname's second segment and returns an enriched context. If already set in ctx or not in workspace mode, returns ctx unchanged.

#### Scenario: workspace slug recovered from pathname
<!-- test: sidebar.test.ts.resolveSidebarCtx-recovers-workspace-slug-from-pathname -->
- **WHEN** `resolveSidebarCtx("/acme/ws1/ask", { orgSlug: "acme" })` is called
- **THEN** `{ orgSlug: "acme", workspaceSlug: "ws1" }` is returned

#### Scenario: already-set workspaceSlug is preserved
<!-- test: sidebar.test.ts.resolveSidebarCtx-preserves-existing-workspaceSlug -->
- **WHEN** `resolveSidebarCtx("/acme/ws1/ask", { orgSlug: "acme", workspaceSlug: "ws2" })` is called
- **THEN** `{ orgSlug: "acme", workspaceSlug: "ws2" }` is returned (unchanged)

#### Scenario: org-mode path does not add workspaceSlug
<!-- test: sidebar.test.ts.resolveSidebarCtx-does-not-add-slug-in-org-mode -->
- **WHEN** `resolveSidebarCtx("/acme/members", { orgSlug: "acme" })` is called (org mode)
- **THEN** `{ orgSlug: "acme" }` is returned (no workspaceSlug added)

---

### Requirement: Determine active sidebar item by longest href prefix match

<!-- id: sidebar.activeHrefFor -->
<!-- entities: URL, SidebarItem -->
<!-- enforced: sidebar.activeHrefFor() -->

When rendering the sidebar, the active item is the one whose href is the longest matching prefix of the current pathname. "Prefix" means exact match OR pathname starts with `href + "/"` (prevents partial-segment false positives like `/settingsX` matching `/settings`). If no item matches, returns `null`.

#### Scenario: exact match takes priority
<!-- test: sidebar.test.ts.activeHrefFor-returns-exact-match -->
- **WHEN** `activeHrefFor("/acme/ws1/settings", ["/acme/ws1", "/acme/ws1/settings"])` is called
- **THEN** "/acme/ws1/settings" is returned

#### Scenario: longest prefix is selected
<!-- test: sidebar.test.ts.activeHrefFor-returns-longest-prefix-match -->
- **WHEN** `activeHrefFor("/acme/ws1/settings/general/advanced", ["/acme/ws1/settings", "/acme/ws1/settings/general"])` is called
- **THEN** "/acme/ws1/settings/general" is returned (longer than /acme/ws1/settings)

#### Scenario: partial-segment false positives are prevented
<!-- test: sidebar.test.ts.activeHrefFor-does-not-match-partial-segments -->
- **WHEN** `activeHrefFor("/acme/ws1/settingsX", ["/acme/ws1/settings"])` is called
- **THEN** `null` is returned (no "/" follows "settings")

#### Scenario: no match returns null
<!-- test: sidebar.test.ts.activeHrefFor-returns-null-when-no-match -->
- **WHEN** `activeHrefFor("/unknown/path", ["/acme/ws1/settings"])` is called
- **THEN** `null` is returned

---

### Requirement: Determine active tab by longest href prefix match

<!-- id: resolve-active-tab.resolveActiveTab -->
<!-- entities: URL, Tab -->
<!-- enforced: resolve-active-tab.resolveActiveTab() -->

Within a parent route (e.g., `/settings`), the active tab is the one whose href is the longest matching prefix of the current pathname. The match uses the same logic as `activeHrefFor()`: exact match OR pathname starts with `href + "/"`. Falls back to the first tab's href when no match is found.

#### Scenario: exact tab match
<!-- test: resolve-active-tab.test.ts.returns-the-exact-match -->
- **WHEN** `resolveActiveTab([{ href: "/settings" }, { href: "/settings/general" }], "/settings/general")` is called
- **THEN** "/settings/general" is returned

#### Scenario: longest prefix tab is selected
<!-- test: resolve-active-tab.test.ts.returns-the-longest-prefix-match -->
- **WHEN** `resolveActiveTab([{ href: "/settings" }, { href: "/settings/general" }], "/settings/general/advanced")` is called
- **THEN** "/settings/general" is returned

#### Scenario: partial-segment false positive prevention
<!-- test: resolve-active-tab.test.ts.does-not-match-partial-segments -->
- **WHEN** `resolveActiveTab([{ href: "/settings" }], "/settingsX")` is called
- **THEN** "/settings" is returned (fallback to first tab, no match)

#### Scenario: no match falls back to first tab
<!-- test: resolve-active-tab.test.ts.falls-back-to-first-tab-href-when-no-match -->
- **WHEN** `resolveActiveTab([{ href: "/a" }, { href: "/b" }], "/unknown")` is called
- **THEN** "/a" is returned (first tab's href)

#### Scenario: empty tabs array returns empty string
<!-- test: resolve-active-tab.test.ts.returns-empty-string-when-tabs-array-is-empty -->
- **WHEN** `resolveActiveTab([], "/any/path")` is called
- **THEN** "" is returned

---

### Requirement: Sidebar config filtered by plan tier

<!-- id: sidebar.getSidebarConfig -->
<!-- entities: SidebarMode, PlanTier, Organization -->
<!-- enforced: sidebar.getSidebarConfig() -->

The sidebar configuration is selected by mode (workspace, org, account) and filtered by org plan tier. Enterprise-only features (e.g., the "Access" item) are removed for non-enterprise orgs.

#### Scenario: workspace mode returns standard config
<!-- test: sidebar.test.ts.getSidebarConfig-workspace-has-all-items -->
- **WHEN** `getSidebarConfig("workspace")` is called
- **THEN** a SidebarConfig with 6 items is returned

#### Scenario: org mode filters access for non-enterprise
<!-- test: sidebar.test.ts.getSidebarConfig-org-filters-access-for-non-enterprise -->
- **WHEN** `getSidebarConfig("org", "pro")` is called
- **THEN** a SidebarConfig with 6 items (no "access") is returned

#### Scenario: org mode includes access for enterprise
<!-- test: sidebar.test.ts.getSidebarConfig-org-includes-access-for-enterprise -->
- **WHEN** `getSidebarConfig("org", "enterprise")` is called
- **THEN** a SidebarConfig with 7 items (including "access") is returned

#### Scenario: account mode returns unchanged
<!-- test: sidebar.test.ts.getSidebarConfig-account-always-has-5-items -->
- **WHEN** `getSidebarConfig("account")` is called
- **THEN** a SidebarConfig with 5 items is returned

---

### Requirement: Enumerate all navigation targets for search/command menu

<!-- id: sidebar.enumerateNavTargets -->
<!-- entities: URL, Scope, SidebarItem -->
<!-- enforced: sidebar.enumerateNavTargets() -->

When a command menu or search bar needs to index all reachable navigation destinations, it calls `enumerateNavTargets(ctx)`. The function flattens all sidebar items across all three modes (account, org, workspace) and every tab from routes.ts into a single list of `{ label, href, parent? }` objects. Each entry is searchable and has its resolved href for the given scope context.

#### Scenario: workspace context returns all workspace+org+account targets
<!-- test: sidebar.test.ts.enumerateNavTargets-workspace-context-includes-workspace-targets -->
- **WHEN** `enumerateNavTargets({ orgSlug: "acme", workspaceSlug: "ws1" })` is called
- **THEN** the list includes workspace-level items (Ask, Knowledge, Automation, Activity, Settings), org-level items, and account-level items

#### Scenario: org context returns org+account targets, no workspace
<!-- test: sidebar.test.ts.enumerateNavTargets-org-context-excludes-workspace-targets -->
- **WHEN** `enumerateNavTargets({ orgSlug: "acme" })` is called
- **THEN** the list includes org and account items, but no workspace-scoped items

#### Scenario: every tab is enumerated with parent reference
<!-- test: sidebar.test.ts.enumerateNavTargets-includes-all-tabs -->
- **WHEN** `enumerateNavTargets({ orgSlug: "acme", workspaceSlug: "ws1" })` is called
- **THEN** Knowledge tabs (Sources, Graph, Memories), Automation tabs (Agents, Playbooks, Event Sources), Activity tabs (Runs, Approvals, Audit), Settings tabs (General, Members, Models) are all included

---

### Requirement: Sidebar item affordance selection

<!-- id: sidebar-item-affordance.sidebarItemAffordance -->
<!-- entities: SidebarItem -->
<!-- enforced: sidebar-item-affordance.sidebarItemAffordance() -->

When rendering a sidebar item, the affordance icon (external ↗, return ↩, or none) is selected by the `sidebarItemAffordance()` function based on the item's boolean flags. `isReturn` takes precedence when both are set (return arrows are more visually prominent). The function returns "return" | "external" | "none".

#### Scenario: return affordance takes priority
<!-- test: sidebar-item-affordance.test.ts.returns-return-when-isReturn-is-true -->
- **WHEN** `sidebarItemAffordance({ isReturn: true, external: true })` is called
- **THEN** "return" is returned

#### Scenario: external affordance when isReturn is false
<!-- test: sidebar-item-affordance.test.ts.returns-external-when-external-is-true -->
- **WHEN** `sidebarItemAffordance({ external: true })` is called
- **THEN** "external" is returned

#### Scenario: no affordance when both flags are false
<!-- test: sidebar-item-affordance.test.ts.returns-none-when-both-flags-are-false -->
- **WHEN** `sidebarItemAffordance({ isReturn: false, external: false })` is called
- **THEN** "none" is returned

---

### Invariant: Proxy is edge-safe (no Node built-ins, DB calls, or secrets)

<!-- entities: Proxy -->
<!-- enforced: proxy.ts (whole file) -->

The proxy SHALL not use Node.js built-ins (fs, path, crypto), make database queries, or access secrets. All operations are strictly edge-compatible: cookie inspection, URL parsing/rewriting, string comparison, and redirects only.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Session validation is per-request, not cached

<!-- entities: Session, Cookie -->
<!-- enforced: session.getSession() (memoized per request only) -->

Session lookup is memoized ONLY within a single React render tree via `cache()`. Across requests (page navigations), the session is re-queried. The session is NOT cached in memory, localStorage, or any persistent store — it is validated server-side on every page boundary.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Org and workspace resolution uses React cache (per-request only)

<!-- entities: Organization, Workspace, Cache -->
<!-- enforced: resolve-org.resolveOrg(), resolve-org.resolveWorkspace() (wrapped in cache()) -->

Both `resolveOrg()` and `resolveWorkspace()` use React `cache()` for per-request memoization. A single slug → row resolution is executed once per render tree. Cache is not shared across requests.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Membership gates use 404 for non-members, not 403

<!-- entities: User, Organization, Workspace -->
<!-- enforced: resolve-org.assertOrgMember(), resolve-org.assertWorkspaceMember(), resolve-org.assertMcpManager(), resolve-org.assertBillingManager(), resolve-org.assertSecurityManager() -->

All membership and role gates call `notFound()` (HTTP 404) for access denials, never 403 Forbidden. This prevents information leakage (404 is indistinguishable from "org/workspace not found"). A non-member and a non-existent org receive the same response.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Reserved org-scope routes block workspace mode

<!-- entities: URL, Scope, OrgScopeRoutes -->
<!-- enforced: sidebar.ORG_SCOPE_ROUTES, sidebar.resolveSidebarMode() -->

The set `ORG_SCOPE_ROUTES` ("members", "access", "security", "billing", "developer", "settings") is the canonical list of org-level route segments. When the second URL segment matches one of these names, the path is org-mode, not workspace-mode, even if a valid workspace slug could exist. This list MUST stay in sync with the route tree under `apps/app/src/app/[orgSlug]/`.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Default tab redirects apply to parent routes

<!-- entities: URL, Routes, Tab -->
<!-- enforced: routes.defaultTab map -->

The `defaultTab` map defines first-tab redirects for parent routes. When a parent route is visited without a tab segment (e.g., `/org/ws/automation`), a redirect to the first tab is issued (e.g., `/org/ws/automation/playbooks`). This map is authoritative and used by layout files to enforce the redirect rule from application-shell spec §5.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Route builders are the sole source of truth for paths

<!-- entities: URL, Routes -->
<!-- enforced: routes.ts (whole file) -->

Every URL in the application is produced by a route builder function from `routes.ts`. No route string is hard-coded elsewhere. Callers import and invoke these builders so that renames stay in one place and all code agrees on the path structure.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Workspace route builders require workspaceSlug

<!-- entities: Routes, Scope -->
<!-- enforced: routes.ts workspace namespace -->

All workspace-scoped route builders accept `Required<ScopeContext>` (forcing `workspaceSlug` to be present) to prevent accidental generation of invalid paths. The caller MUST verify `workspaceSlug` is defined before calling these builders.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Active tab matching prevents partial-segment false positives

<!-- entities: URL, Tab -->
<!-- enforced: resolve-active-tab.resolveActiveTab(), sidebar.activeHrefFor() -->

Both active-tab and active-href matching require a "/" boundary after the href. `/settingsX` does NOT match `/settings` because no "/" follows the href. This prevents accidental cross-branch highlighting.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Longest match wins in active-tab and active-href selection

<!-- entities: URL, Item -->
<!-- enforced: resolve-active-tab.resolveActiveTab(), sidebar.activeHrefFor() -->

When multiple items match the pathname, the one with the longest href is selected. This ensures that `/acme/ws1/settings/general` highlights "Settings · General", not the parent "Settings" item.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Workspace mode fallbacks are used when workspaceSlug is absent

<!-- entities: Scope, Sidebar, Routes -->
<!-- enforced: sidebar.ts (all workspace items) -->

Workspace sidebar items include conditional fallbacks in their `href()` functions. When `ctx.workspaceSlug` is absent, they fallback to `/org` or `/`. This is a safety measure for the org-layout boundary where no workspace param is available. The fallback is visible when the shell is mounted without workspace context.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: proxy.ts has no unit tests; behavior is verified only by E2E coverage and manual testing. The session cookie matching pattern (`*.session_token`) relies on Better Auth's cookie naming convention, which could drift if the library is upgraded. -->
<!-- uncertainty: resolve-org.ts session.ts isolation: session.ts gets session from Better Auth headers; resolve-org.ts gets userId from that session; the coupling is not enforced at compile time. -->
<!-- uncertainty: The workspace description extraction from settings JSONB (resolve-org.ts lines 65-70) mirrors the mapWorkspaceSettingsRow handler, but the key name (`description`) is hardcoded in two places. If one is updated and the other is not, the behavior silently diverges. -->
<!-- deferred: Authentication handler integration (apps/app/src/lib/auth.ts), Better Auth session table schema, workspace settings table structure and JSONB schema, the full route tree at apps/app/src/app, sidebar rendering components (SidebarContext, SidebarItem), and E2E test stubs for proxy redirects. -->
