# Spec: app-server-actions

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: apps/app/src/app/actions/*.action.ts, apps/app/src/lib/actions/*.ts
> Last verified: 2026-06-20 (commit 2f62850)

**Description:** Next.js "use server" Server Actions that create a tenancy and authorization boundary between the frontend and the Oxagen capability handlers. Each action validates authentication (session + org/workspace membership), resolves real IDs from URL slugs (preventing IDOR), validates input against capability contracts, and routes through `invoke()` to emit metering, IAM, and audit signals.

---

### Requirement: Authenticate caller and resolve tenant scope before delegating to capability
<!-- id: createWorkspaceInlineAction.resolveOrg -->
<!-- entities: User, Organization, Workspace -->
<!-- enforced: createWorkspaceInlineAction() -->

The action SHALL call `getSessionOrRedirect()` to verify the user is authenticated. If authentication fails, return `{ ok: false, error: "Not authenticated..." }` without resolving org or invoking the capability. Upon success, resolve the org and workspace from URL slugs using `resolveOrg()` and `resolveWorkspace()`. If either resolution fails (slug not found), return `{ ok: false, error: "Org or workspace not found." }`.

#### Scenario: Authenticated user with valid org and workspace
<!-- test: createWorkspaceInlineAction.returns ok:true with workspaceSlug on success -->
- **WHEN** `getSessionOrRedirect()` succeeds AND `resolveOrg()` and `resolveWorkspace()` succeed
- **THEN** the action continues to invoke the capability handler

#### Scenario: User not authenticated
<!-- test: createWorkspaceInlineAction.returns ok:false when getSessionOrRedirect throws -->
- **WHEN** `getSessionOrRedirect()` throws any error
- **THEN** return `{ ok: false, error: "Not authenticated..." }`

#### Scenario: Organization slug not found
<!-- test: createWorkspaceInlineAction.returns ok:false when resolveOrg throws (org not found) -->
- **WHEN** `resolveOrg(slug)` finds no matching organization
- **THEN** return `{ ok: false, error: "Org or workspace not found." }`

#### Scenario: Workspace slug not found
<!-- test: updateModelSettingsAction.returns ok:false when resolveWorkspace throws -->
- **WHEN** `resolveWorkspace(orgId, slug)` finds no matching workspace
- **THEN** return `{ ok: false, error: "Org or workspace not found." }`

---

### Requirement: Assert user is an organization member before delegating to capability
<!-- id: assertOrgMember -->
<!-- entities: User, Organization -->
<!-- depends_on: Authenticate caller and resolve tenant scope before delegating to capability -->
<!-- enforced: createAutomationInlineAction() -->

The action SHALL call `assertOrgMember(orgId, userId)` after resolving the org, asserting the authenticated user holds a row in the org_users table. If the user is not a member, `assertOrgMember()` calls `notFound()` (rendered as HTTP 404), which the action catches and returns `{ ok: false, error: "Org or workspace not found." }` (intentionally indistinguishable from org-not-found to prevent membership enumeration attacks).

#### Scenario: User is a member of the resolved organization
<!-- test: updateModelSettingsAction.asserts org membership for the authenticated user -->
- **WHEN** the org is resolved AND `assertOrgMember(orgId, userId)` finds the user in org_users
- **THEN** continue to invoke the capability

#### Scenario: User is not an organization member
<!-- test: updateModelSettingsAction.returns ok:false when assertOrgMember throws (user not a member) -->
- **WHEN** `assertOrgMember(orgId, userId)` finds no row for the user in org_users
- **THEN** return `{ ok: false, error: "Org or workspace not found." }` (404 surfaces as generic not-found)

---

### Requirement: Validate capability input against contract schema before invoking
<!-- id: updateModelSettingsAction.safeParse -->
<!-- entities: Capability, Input -->
<!-- enforced: updateModelSettingsAction() -->

The action SHALL validate the input object against the capability's Zod schema (e.g., `workspaceModelSettingsWrite.input.safeParse()`), applying contract type coercion and validation rules (enums, ranges, required fields). If validation fails, return `{ ok: false, error: <first validation error message> }` immediately without calling `getSessionOrRedirect()` or invoking.

#### Scenario: Valid input passes schema validation
<!-- test: updateModelSettingsAction.returns ok:true on success -->
- **WHEN** input passes all Zod validation rules
- **THEN** continue to authentication and invoke steps

#### Scenario: Invalid enum value for model tier
<!-- test: updateModelSettingsAction.returns ok:false when defaultTextTier is an invalid enum value -->
- **WHEN** `defaultTextTier` is not one of the allowed enum values ("fast", "balanced", "precise")
- **THEN** return `{ ok: false, error: <Zod validation message> }` and skip all downstream steps

#### Scenario: Empty or invalid prompt
<!-- test: videoGenerateAction.returns ok:false when prompt is an empty string -->
- **WHEN** `prompt` is an empty string
- **THEN** return `{ ok: false, error: <Zod validation message> }`

#### Scenario: Invalid aspect ratio
<!-- test: videoGenerateAction.returns ok:false when aspectRatio is invalid -->
- **WHEN** `aspectRatio` is not one of "16:9", "9:16", "1:1"
- **THEN** return `{ ok: false, error: <Zod validation message> }`

#### Scenario: Duration out of range
<!-- test: videoGenerateAction.returns ok:false when durationSeconds exceeds 60 -->
- **WHEN** `durationSeconds` > 60 or <= 0
- **THEN** return `{ ok: false, error: <Zod validation message> }`

---

### Requirement: Build capability context with real org/workspace IDs and authenticated user
<!-- id: createAutomationInlineAction.ctx -->
<!-- entities: CapabilityContext, User, Organization, Workspace -->
<!-- depends_on: Authenticate caller and resolve tenant scope before delegating to capability -->
<!-- triggers: Route request through invoke() with real tenant scope -->
<!-- enforced: createAutomationInlineAction() -->

After authentication and scope resolution, the action SHALL construct a `CapabilityContext` object containing the resolved `orgId`, `workspaceId`, authenticated `userId`, `requestId` (a fresh UUID), `surface: "app"`, and optional `apiKeyId` (null for user-initiated actions) and `messageId` (null). This context is passed to `invoke()` to provide the real tenant scope required by the capability handler and RLS gates.

#### Scenario: Context is built with real IDs
<!-- test: updateModelSettingsAction.calls invoke with workspace.model.settings.write and correct ctx -->
- **WHEN** authentication succeeds, org/workspace are resolved, and membership is asserted
- **THEN** `ctx.orgId` equals the resolved org ID, `ctx.workspaceId` equals the resolved workspace ID, and `ctx.userId` equals the authenticated user ID

#### Scenario: Context includes required metadata fields
<!-- test: createApiKeyAction.wires orgId and userId into ctx -->
- **WHEN** the context is built
- **THEN** `ctx.surface === "app"`, `ctx.apiKeyId === null`, and `ctx.requestId` is a non-empty UUID string

---

### Requirement: Route request through invoke() to emit metering, IAM, and audit signals
<!-- id: createAutomationInlineAction.invoke -->
<!-- entities: Capability, CapabilityContext -->
<!-- depends_on: Build capability context with real org/workspace IDs and authenticated user -->
<!-- enforced: createAutomationInlineAction() -->

The action SHALL call `invoke(capabilityName, parsedInput, ctx, options)` to execute the capability handler. The `invoke()` function is the single chokepoint through which all metering, billing, IAM authorization, and audit logging flow. Every call includes the real tenant scope (`orgId`, `workspaceId`, `userId`) so the kernel can emit complete metering records and check entitlements.

#### Scenario: Capability invocation succeeds
<!-- test: videoGenerateAction.calls invoke with video.generate and the correct capability payload -->
- **WHEN** `invoke()` completes without error
- **THEN** return the capability output (or a wrapped result like `{ ok: true, queued: true, jobId }`)

#### Scenario: Capability invocation fails
<!-- test: updateModelSettingsAction.returns ok:false with error message when invoke throws -->
- **WHEN** `invoke()` throws an error (handler failure, insufficient entitlement, quota exceeded, etc.)
- **THEN** catch the error, extract the error message (or use a fallback), and return `{ ok: false, error: <message> }`

---

### Requirement: Use org-only sentinel workspace ID for org-scoped capabilities
<!-- id: createApiKeyAction.ORG_ONLY_WS -->
<!-- entities: Organization, Capability -->
<!-- enforced: createApiKeyAction() -->

For capabilities that are org-scoped (e.g., `api.key.create`) and do not belong to a specific workspace, the action SHALL use the sentinel workspace ID `"00000000-0000-0000-0000-000000000000"` in the capability context. This placeholder allows the handler and RLS gates to function without a real workspace while still respecting org scoping (see OXA-1515).

#### Scenario: API key creation uses sentinel workspace ID
<!-- test: createApiKeyAction.uses org-only sentinel workspace id in ctx -->
- **WHEN** `createApiKeyAction()` builds the context for an org-scoped capability
- **THEN** `ctx.workspaceId === "00000000-0000-0000-0000-000000000000"`

---

### Requirement: Transform user input into capability contract input before invocation
<!-- id: createWorkspaceInlineAction.FormData -->
<!-- entities: Input, Capability -->
<!-- depends_on: Validate capability input against contract schema before invoking -->
<!-- enforced: createWorkspaceInlineAction() -->

Some actions transform the user-facing input into the shape expected by the capability contract. For `createWorkspaceInlineAction()`, the action constructs a `FormData` object from the validated input fields (`name` and `slug`), then passes it to the downstream `createWorkspaceAction()` function. This transformation is transparent to the caller but allows flexible input shaping at the action boundary.

#### Scenario: Workspace inline action transforms input to FormData
<!-- test: createWorkspaceInlineAction.calls createWorkspaceAction with correct orgSlug and FormData containing name+slug -->
- **WHEN** the action delegates to `createWorkspaceAction(orgSlug, formData)`
- **THEN** the FormData contains `name` and `slug` keys with the input values

---

### Requirement: Coerce trigger and step configurations for automation creation
<!-- id: createAutomationInlineAction.triggerConfig -->
<!-- entities: Automation, Input -->
<!-- depends_on: Validate capability input against contract schema before invoking -->
<!-- enforced: createAutomationInlineAction() -->

For automation creation, the action coerces optional nested objects (`triggerConfig`, `steps`) to empty objects if not provided (e.g., `input.triggerConfig ?? {}`). This ensures the capability receives consistent input shape even when the user provides sparse input.

#### Scenario: Trigger and step configs default to empty objects
<!-- test: automation-inline.action.ts constructs contractInput with triggerConfig and steps -->
- **WHEN** `triggerConfig` or `steps` are undefined
- **THEN** they are coerced to `{}` and `[]` respectively before passing to `invoke()`

---

### Requirement: Always create automations in disabled state, requiring explicit user enable
<!-- id: createAutomationInlineAction.enabled -->
<!-- entities: Automation -->
<!-- depends_on: Coerce trigger and step configurations for automation creation -->
<!-- enforced: createAutomationInlineAction() -->

The action SHALL always set `enabled: false` when creating an automation, regardless of user input. This ensures automations are never active immediately after creation — the user must explicitly click an "Enable" button to activate the automation, providing a confirmation step against accidental activation.

#### Scenario: Automation creation sets enabled to false
<!-- test: automation-inline.action.ts always sets enabled: false -->
- **WHEN** `createAutomationInlineAction()` builds the contract input
- **THEN** the `enabled` field is hardcoded to `false`

---

### Requirement: Route automation enable through invoke() with same tenant scope
<!-- id: enableAutomationInlineAction.invoke -->
<!-- entities: Automation, CapabilityContext -->
<!-- enforced: enableAutomationInlineAction() -->

When the user clicks the "Enable" button, the action calls `enableAutomationInlineAction()`, which follows the same pattern: authenticate, resolve tenant scope, assert membership, build context, and call `invoke("automation.enable", { automation_id }, ctx)`. This ensures the enable action is also metered, audited, and subject to entitlement checks.

#### Scenario: Enable action succeeds
<!-- test: automation-inline.action.ts enableAutomationInlineAction routes through invoke -->
- **WHEN** `enableAutomationInlineAction()` is called with valid org/workspace/automation_id
- **THEN** return `{ ok: true, result: <automation enable output> }`

#### Scenario: Enable action fails
- **WHEN** `invoke()` or scope resolution fails
- **THEN** return `{ ok: false, error: <message> }`

---

### Requirement: Queue async video generation jobs and return jobId
<!-- id: videoGenerateAction.jobId -->
<!-- entities: Video, Job, Capability -->
<!-- depends_on: Route request through invoke() to emit metering, IAM, and audit signals -->
<!-- enforced: videoGenerateAction() -->

When video generation is requested, `invoke("video.generate", ...)` returns an object containing a `jobId`. The action SHALL wrap this in `{ ok: true, queued: true, jobId }`, signaling to the client that the job has been queued asynchronously (not yet complete). The client can poll or subscribe to job status using the jobId.

#### Scenario: Video generation job is queued
<!-- test: videoGenerateAction.returns ok:true with queued:true and a jobId -->
- **WHEN** `invoke("video.generate", ...)` succeeds
- **THEN** return `{ ok: true, queued: true, jobId: <value from handler> }`

#### Scenario: Video generation job fails to queue
<!-- test: videoGenerateAction.returns ok:false with error message when invoke throws an Error -->
- **WHEN** `invoke()` throws an error
- **THEN** return `{ ok: false, error: <message> }`

---

### Requirement: Build shared capability context helper for multi-action patterns
<!-- id: buildNotificationCtx -->
<!-- entities: CapabilityContext, User, Organization, Workspace -->
<!-- enforced: notifications.ts.buildNotificationCtx() -->

When multiple actions in the same module share the same authentication/scope-resolution pattern, the module SHALL extract a `buildNotificationCtx()` helper function to avoid duplication. This helper calls `getSessionOrRedirect()`, `resolveOrg()`, `resolveWorkspace()`, and `assertOrgMember()` in sequence, catching errors and returning a single context object. Each action calls this helper once before invoking its capability.

#### Scenario: Shared context builder is called by listNotificationsAction
<!-- test: listNotificationsAction.wires orgId, workspaceId, userId, surface into ctx -->
- **WHEN** `listNotificationsAction(orgSlug, workspaceSlug)` is called
- **THEN** it calls `buildNotificationCtx()` to set up `orgId`, `workspaceId`, `userId`, and `surface`

#### Scenario: Shared context builder is called by markNotificationAction
<!-- test: markNotificationAction.wires ctx correctly -->
- **WHEN** `markNotificationAction(orgSlug, workspaceSlug, id, opts)` is called
- **THEN** it calls `buildNotificationCtx()` to set up the same context fields

---

### Requirement: Accept optional filter and limit parameters on list actions
<!-- id: listNotificationsAction.opts -->
<!-- entities: Notification, Input -->
<!-- enforced: listNotificationsAction() -->

List actions like `listNotificationsAction()` SHALL accept an optional `opts` parameter with fields like `unreadOnly` and `limit`. The action SHALL validate these against the capability contract and use sensible defaults (e.g., `unreadOnly: false`, `limit: 50`) if not provided.

#### Scenario: List action with no options uses defaults
<!-- test: listNotificationsAction.uses default unreadOnly: false, limit: 50 when no opts passed -->
- **WHEN** `listNotificationsAction(orgSlug, workspaceSlug)` is called with no opts
- **THEN** the input to `invoke()` includes `unreadOnly: false` and `limit: 50`

#### Scenario: List action with custom options
<!-- test: listNotificationsAction.passes unreadOnly and limit to the capability -->
- **WHEN** `listNotificationsAction(orgSlug, workspaceSlug, { unreadOnly: true, limit: 10 })` is called
- **THEN** the input to `invoke()` includes `unreadOnly: true` and `limit: 10`

---

### Requirement: Mark notifications with read/archived flags via invoke
<!-- id: markNotificationAction.mark -->
<!-- entities: Notification, Input -->
<!-- enforced: markNotificationAction() -->

The `markNotificationAction()` SHALL accept an optional `opts` parameter with `read` and `archived` boolean flags. These flags are merged into the capability input (e.g., `{ id, read, archived }`) and passed to `invoke("notification.mark", ...)`. The action returns the marked notification object on success.

#### Scenario: Mark notification as read
<!-- test: markNotificationAction.passes id and read flag to the capability input -->
- **WHEN** `markNotificationAction(orgSlug, workspaceSlug, "notif-1", { read: true })` is called
- **THEN** `invoke()` is called with input containing `id: "notif-1"` and `read: true`

#### Scenario: Archive notification
<!-- test: markNotificationAction.passes archived flag to the capability input -->
- **WHEN** `markNotificationAction(orgSlug, workspaceSlug, "notif-2", { archived: true })` is called
- **THEN** `invoke()` is called with input containing `id: "notif-2"` and `archived: true`

---

### Requirement: Parse and validate capability output against contract schema
<!-- id: createApiKeyAction.output.parse -->
<!-- entities: Capability, Output -->
<!-- enforced: createApiKeyAction() -->

Some actions (especially those that are org-scoped or return complex objects) parse and validate the capability output against the contract's output schema. This ensures the output is well-typed before returning to the caller (e.g., `return apiKeyCreate.output.parse(result)`).

#### Scenario: API key action validates output
<!-- test: createApiKeyAction.returns the parsed output from invoke -->
- **WHEN** `invoke("api.key.create", ...)` succeeds
- **THEN** the output is validated via `apiKeyCreate.output.parse()` and returned

---

### Requirement: Propagate capability handler errors to the caller
<!-- id: createApiKeyAction.error -->
<!-- entities: Error, Capability -->
<!-- enforced: createApiKeyAction() -->

For actions that throw errors rather than returning `{ ok: false, error }`, any error from `invoke()` or scope resolution is propagated directly to the caller (using `throw`). This includes authentication failures, org-not-found, membership assertion failures, and handler errors. The caller is expected to handle these errors in a try-catch or use `rejectOnError`-style error boundaries.

#### Scenario: API key action propagates authentication error
<!-- test: createApiKeyAction.propagates errors from getSessionOrRedirect -->
- **WHEN** `getSessionOrRedirect()` throws
- **THEN** the error is propagated to the caller (not caught)

#### Scenario: API key action propagates handler error
<!-- test: createApiKeyAction.propagates errors from invoke -->
- **WHEN** `invoke()` throws
- **THEN** the error is propagated to the caller

---

### Invariant: All server actions require authentication
<!-- entities: User, Session -->
<!-- enforced: getSessionOrRedirect() -->

Every server action (without exception) SHALL call `getSessionOrRedirect()` at the start. If the session does not exist or is invalid, `getSessionOrRedirect()` throws (redirecting the browser to `/login`), and the action returns an error or throws. No authenticated action runs without a valid session.

> Last verified: 2026-06-20 (commit 2f62850)

---

### Invariant: All workspace-scoped actions assert org membership
<!-- entities: User, Organization, Workspace -->
<!-- enforced: assertOrgMember() -->

Every action that operates on workspace-scoped data (e.g., automation, model settings, video generation) SHALL call `assertOrgMember(orgId, userId)` after resolving the org. This gate prevents IDOR attacks where an authenticated user could access org data by guessing a slug. The assertion calls `notFound()` if the user is not a member, which the action catches and returns as a generic "org not found" error (404 surfaces as not-found, not forbidden, to avoid membership enumeration).

> Last verified: 2026-06-20 (commit 2f62850)

---

### Invariant: All server actions use real org/workspace IDs, never stub placeholders
<!-- entities: Organization, Workspace, Capability -->
<!-- enforced: resolveOrg(), resolveWorkspace() -->

Every server action SHALL resolve the org and workspace from URL slugs using `resolveOrg()` and `resolveWorkspace()`, producing real database IDs. These IDs are passed to `invoke()` in the capability context. Stub or placeholder IDs (other than the org-only sentinel `"00000000-0000-0000-0000-000000000000"` for org-scoped actions) MUST NOT be used, as they silence RLS and entitlement checks in the handler.

> Last verified: 2026-06-20 (commit 2f62850)

---

### Invariant: All validation errors short-circuit authentication and invocation
<!-- entities: Input, Capability -->
<!-- enforced: Zod safeParse() -->

Validation errors from contract input schema checks (e.g., `workspaceModelSettingsWrite.input.safeParse()`) are returned immediately without calling `getSessionOrRedirect()` or `invoke()`. This avoids wasting database queries and billing events on known-bad requests. Validation checks the input shape BEFORE the caller is authenticated.

> Last verified: 2026-06-20 (commit 2f62850)

---

### Invariant: All capability invocations route through invoke() chokepoint
<!-- entities: Capability, CapabilityContext -->
<!-- enforced: invoke() -->

Every capability invocation in a server action uses the `invoke()` function, never a direct handler call. The `invoke()` function is the single enforcement point for metering, billing entitlement checks, IAM authorization, and audit logging. Bypassing `invoke()` silently skips all these gates, creating a security and billing gap.

> Last verified: 2026-06-20 (commit 2f62850)

---

### Invariant: All server actions include side-effect import of @oxagen/handlers/register
<!-- entities: Handler, Kernel -->
<!-- enforced: import "@oxagen/handlers/register" -->

Every server action module that calls `invoke()` MUST include a side-effect import: `import "@oxagen/handlers/register"`. This statement binds every foundation handler into the shared kernel so `invoke()` can resolve handlers by name at runtime. Omitting this import causes `invoke()` to throw "No handler registered for capability X" (silently at runtime, not caught by the type system).

> Last verified: 2026-06-20 (commit 2f62850)

---

<!-- deferred: None — all entry points and call chains read. -->
<!-- uncertainty: createWorkspaceInlineAction() delegates to createWorkspaceAction() from app/[orgSlug]/new-workspace/actions, which is not in scope for this mining session. The downstream action's validation and behavior are not fully captured in this spec; only the boundary at createWorkspaceInlineAction() is documented. -->
