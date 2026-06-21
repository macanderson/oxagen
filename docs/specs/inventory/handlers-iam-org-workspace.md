# Spec: handlers-iam-org-workspace

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: organization.create.ts, org.member.add.ts, org.member.invite.accept.ts, org.member.invite.decline.ts, org.member.remove.ts, org.member.role.change.ts, org.settings.read.ts, org.settings.write.ts, iam-provision.ts, workspace.create.ts, workspace.invite.send.ts, workspace.member.list.ts, workspace.settings.read.ts, workspace.settings.write.ts, user.preferences.read.ts, user.preferences.write.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Authenticated user creates a new organization

<!-- id: organization.create.organizationCreateHandler -->
<!-- entities: User, Organization, OrgUser, Principal, Role, RoleGrant -->
<!-- enforced: organization.create.organizationCreateHandler() -->
<!-- test: organization.create.test.ts -->

When an authenticated user submits a valid organization creation request with name, slug, type, and optional billing details, the system SHALL create a new org row, assign the creator as owner, bootstrap IAM (7 system roles, owner principal, owner role assignment, and role grants from every capability's defaultRoles), grant free credits, and seed default workspace resources. Slug MUST be unique across all orgs; duplicate attempts return a friendly error. Business-type orgs persist website/industry/employeeSize; personal orgs leave these fields null. Billing profile is persisted if billingEmail or billingAddress is provided.

#### Scenario: Happy path — authenticated user creates personal org
<!-- test: organization.create.test.ts:returns new org publicId, name, slug, type, ISO createdAt -->

- **WHEN** ctx.userId is set AND input.type === "personal" AND no existing org has input.slug
- **THEN** insert organizations row (name, slug, type="personal", status="active", website/industry/employeeSize=null), insert orgUsers row (orgId, userId, role="owner"), call bootstrapOrgIAM (upsert 7 system roles, upsert owner principal, assign owner "Owner" role, seed role_grants), call grantFreeCredits(orgId), emit organization.created security event, return {publicId, name, slug, type, createdAt as ISO string}

#### Scenario: Authenticated user creates business org with billing address
<!-- test: organization.create.test.ts:inserts billing profile with US address — region and country uppercased -->

- **WHEN** ctx.userId is set AND input.type === "business" AND input.billingAddress.country === "US" AND all billing fields provided
- **THEN** insert organizations row (name, slug, type="business", website/industry/employeeSize preserved), insert orgBillingProfiles row (billingEmail, addressLine1/2, city, region uppercased, postalCode, country uppercased, placeId), emit organization.created event, return org details

#### Scenario: Unauthenticated user attempts org creation
<!-- test: organization.create.test.ts:throws when userId is null -->

- **WHEN** ctx.userId is null
- **THEN** throw Error "organization.create requires an authenticated user"

#### Scenario: Slug collision detected during insert
<!-- test: organization.create.test.ts:throws friendly error on unique_violation (race condition) -->

- **WHEN** unique_violation (code 23505) is raised during org insert (race condition)
- **THEN** throw Error "slug "{slug}" already in use"

#### Scenario: Free credits grant fails (non-fatal)
<!-- test: organization.create.test.ts:does not throw when grantFreeCredits fails — org creation still succeeds -->

- **WHEN** grantFreeCredits(orgId) raises an error after org creation transaction commits
- **THEN** log error but do not fail the handler; org creation and IAM bootstrap succeed; credits grant can be re-applied manually

---

### Requirement: Organization member invitation sent via add capability

<!-- id: org.member.add.orgMemberAddHandler -->
<!-- entities: Organization, Invitation, User -->
<!-- depends_on: Organization created successfully -->
<!-- enforced: org.member.add.orgMemberAddHandler() -->
<!-- test: org.member.add.test.ts -->

When an authenticated principal (user or API key) invokes org.member.add for an org with available seats, a pending invitation is created for the specified email with a 30-day TTL. A partial unique index on (orgId, email) WHERE status='pending' makes this idempotent: duplicate invites return a friendly error. The pending invitation occupies a seat until accepted, declined, or expired. Invitations are scoped to the tenant (withTenantDb).

#### Scenario: Authorized actor sends invitation with available seats
<!-- test: org.member.add.test.ts:happy path → returns pending invitation with correct shape -->

- **WHEN** ctx.userId or ctx.apiKeyId is set AND ctx.orgId is set AND assertSeatAvailable(orgId) passes AND no pending invitation exists for (orgId, email)
- **THEN** insert invitations row (orgId, email, role, status="pending", invitedByUserId, expiresAt = now + 30 days), emit org.member_invited security event, return {invitationId: publicId, email, role, status: "pending", expiresAt as ISO string}

#### Scenario: Duplicate pending invitation detected
<!-- test: org.member.add.test.ts:duplicate pending invite (Postgres 23505) → friendly error -->

- **WHEN** unique_violation on (orgId, email) WHERE status='pending'
- **THEN** throw Error "A pending invitation for {email} already exists in this org. Revoke or wait for it to expire before resending."

#### Scenario: Organization at seat capacity
<!-- test: org.member.add.test.ts:seat limit reached → re-throws SeatLimitError with correct code -->

- **WHEN** ctx.userId or ctx.apiKeyId is set AND assertSeatAvailable(orgId) raises SeatLimitError
- **THEN** re-throw SeatLimitError as-is; API/MCP layer surfaces 402 with code:"seat_limit_reached"

#### Scenario: No authenticated principal
<!-- test: org.member.add.test.ts:no authenticated principal → throws Unauthorized -->

- **WHEN** ctx.userId is null AND ctx.apiKeyId is null
- **THEN** throw Error "Unauthorized: no authenticated principal"

#### Scenario: Missing orgId
<!-- test: org.member.add.test.ts:no orgId → throws Forbidden -->

- **WHEN** ctx.orgId is null or empty
- **THEN** throw Error "Forbidden: orgId is required to invite a member"

---

### Requirement: Invited user accepts org membership

<!-- id: org.member.invite.accept.orgMemberInviteAcceptHandler -->
<!-- entities: Invitation, User, OrgUser, Principal, Role, PrincipalRoleAssignment -->
<!-- depends_on: Organization member invitation sent via add capability -->
<!-- triggers: Organization member removed; member role changed -->
<!-- enforced: org.member.invite.accept.orgMemberInviteAcceptHandler() -->
<!-- test: org.member.invite.accept.test.ts -->

When an authenticated user accepts a pending invitation by publicId, the system SHALL verify the user's email matches the invitation email (case-insensitive), mark the invitation 'accepted', create an org_users membership row with the invited role, provision a least-privilege IAM principal, assign the invited role to that principal, and emit org.role_changed event. Cross-org lookups require withSystemDb bypass (the invitee's ctx.orgId may differ from invitation.orgId).

#### Scenario: User accepts pending invitation with matching email
<!-- test: org.member.invite.accept.test.ts:invitation accepted, membership created -->

- **WHEN** ctx.userId is set AND invitation.status === "pending" AND invitation.expiresAt > now AND userEmail.toLowerCase() === invitation.email.toLowerCase()
- **THEN** mark invitations row status="accepted", acceptedUserId=ctx.userId; insert org_users row (orgId, userId, role from invitation, joinedAt=now); call provisionMemberPrincipal (upsert least-privilege principal with no role assignment); lookup org role by name; insert principal_role_assignments row (principalId, roleId, orgId, assignedBy=ctx.userId); return {orgUserId, orgId, role, joinedAt as ISO string}; emit org.role_changed event

#### Scenario: Invitation expired
<!-- test: org.member.invite.accept.test.ts -->

- **WHEN** invitation.status === "pending" AND invitation.expiresAt < now
- **THEN** mark invitations row status="expired" (best-effort, non-fatal if fails); throw Error "Invitation '{invitationPublicId}' has expired"

#### Scenario: Invitation no longer pending
<!-- test: org.member.invite.accept.test.ts -->

- **WHEN** invitation.status !== "pending"
- **THEN** throw Error "Invitation '{invitationPublicId}' is no longer pending (status: {status})"

#### Scenario: Email mismatch
<!-- test: org.member.invite.accept.test.ts -->

- **WHEN** ctx.userId is set AND userEmail.toLowerCase() !== invitation.email.toLowerCase()
- **THEN** throw Error "This invitation was not issued to your email address"

#### Scenario: Unauthenticated user attempts accept
<!-- test: org.member.invite.accept.test.ts -->

- **WHEN** ctx.userId is null
- **THEN** throw Error "Unauthorized: must be authenticated to accept an invitation"

#### Scenario: Invitation not found
<!-- test: org.member.invite.accept.test.ts -->

- **WHEN** invitation.publicId does not exist in invitations table
- **THEN** throw Error "Invitation '{invitationPublicId}' not found"

---

### Requirement: Invited user declines org membership invitation

<!-- id: org.member.invite.decline.orgMemberInviteDeclineHandler -->
<!-- entities: Invitation -->
<!-- depends_on: Organization member invitation sent via add capability -->
<!-- enforced: org.member.invite.decline.orgMemberInviteDeclineHandler() -->
<!-- test: org.member.invite.decline.test.ts -->

When an authenticated principal declines a pending invitation by publicId, the invitation status is marked 'declined' and the seat is immediately freed. Cross-org lookups via withSystemDb are required. The decliner must either be the email-matching user (check omitted — IAM layer enforces) or an Owner/Admin (enforced by capability defaultRoles).

#### Scenario: User declines own pending invitation
<!-- test: org.member.invite.decline.test.ts -->

- **WHEN** ctx.userId or ctx.apiKeyId is set AND invitation.status === "pending"
- **THEN** mark invitations row status="declined", updatedAt=now, updatedByUserId=actorId; return {invitationPublicId, status: "declined"}

#### Scenario: Invitation not found
<!-- test: org.member.invite.decline.test.ts -->

- **WHEN** invitation.publicId does not exist
- **THEN** throw Error "Invitation '{invitationPublicId}' not found"

#### Scenario: Invitation not pending
<!-- test: org.member.invite.decline.test.ts -->

- **WHEN** invitation.status !== "pending"
- **THEN** throw Error "Invitation '{invitationPublicId}' is no longer pending (status: {status})"

#### Scenario: Unauthenticated principal attempts decline
<!-- test: org.member.invite.decline.test.ts -->

- **WHEN** ctx.userId is null AND ctx.apiKeyId is null
- **THEN** throw Error "Unauthorized: must be authenticated to decline an invitation"

---

### Requirement: Organization member removed by owner or admin

<!-- id: org.member.remove.orgMemberRemoveHandler -->
<!-- entities: Organization, OrgUser, Principal, PrincipalRoleAssignment, Role -->
<!-- enforced: org.member.remove.orgMemberRemoveHandler() -->
<!-- test: org.member.remove.test.ts -->

When an Owner or Admin invokes org.member.remove for a target user, the system SHALL verify the actor holds Owner or Admin role (via principal_role_assignments → roles, not legacy org_users.role), confirm the target belongs to this org (IDOR guard), block removal of the last org Owner, then atomically: delete org_users row, soft-delete all principal_role_assignments for the target's principal (set deletedAt), and mark the principal status='deleted'. All reads and mutations occur within a single tenant-scoped transaction (withTenantDb).

#### Scenario: Owner removes member from org
<!-- test: org.member.remove.test.ts:owner removes non-owner member -->

- **WHEN** ctx.userId or ctx.apiKeyId is set AND ctx.orgId is set AND actor resolves to active principal with "Owner" or "Admin" role AND target userId exists in orgUsers for this org AND target is not the only remaining Owner
- **THEN** resolve actor's principal and highest-precedence org role; verify role in {Owner, Admin}; resolve target orgUsers row (404 if not in this org); count active Owner assignments; if target is Owner and count <= 1, throw "Cannot remove the last org owner"; resolve target principal; soft-delete all org-scoped principal_role_assignments (set deletedAt, updatedBy); mark principal status='deleted'; delete org_users row; emit org.member_removed event; return {removed: true, targetUserId, orgId}

#### Scenario: Non-owner attempts removal
<!-- test: org.member.remove.test.ts -->

- **WHEN** actor's principal holds role not in {Owner, Admin}
- **THEN** throw Error "Forbidden: only org Owners and Admins can remove members"

#### Scenario: Last owner removal blocked
<!-- test: org.member.remove.test.ts:blocked — would remove last org owner -->

- **WHEN** target userId is an Owner AND count of active Owner role assignments === 1
- **THEN** throw Error "Cannot remove the last org owner. Transfer ownership first or promote another member to Owner."

#### Scenario: Target not a member of this org (IDOR)
<!-- test: org.member.remove.test.ts -->

- **WHEN** target userId has no org_users row for ctx.orgId
- **THEN** throw Error "Not found: target user is not a member of this org" (404, no leak of existence)

#### Scenario: No authenticated principal
<!-- test: org.member.remove.test.ts -->

- **WHEN** ctx.userId is null AND ctx.apiKeyId is null
- **THEN** throw Error "Unauthorized: no authenticated principal"

#### Scenario: Missing orgId
<!-- test: org.member.remove.test.ts -->

- **WHEN** ctx.orgId is null or empty
- **THEN** throw Error "Forbidden: orgId is required"

---

### Requirement: Organization member role changed by owner or admin

<!-- id: org.member.role.change.orgMemberRoleChangeHandler -->
<!-- entities: Organization, OrgUser, Principal, PrincipalRoleAssignment, Role -->
<!-- enforced: org.member.role.change.orgMemberRoleChangeHandler() -->
<!-- test: org.member.role.change.test.ts -->

When an Owner or Admin invokes org.member.role.change for a target user and newRole, the system SHALL verify the actor holds Owner or Admin role, confirm the target belongs to this org (IDOR guard), resolve the requested role (must exist as org-scoped system role), block demotion of the last Owner, then atomically: soft-delete all existing org-scoped role assignments (replace wholesale), insert new role assignment, and update legacy org_users.role for UI consistency. All reads and mutations occur within a single tenant-scoped transaction (withTenantDb).

#### Scenario: Owner promotes member to admin
<!-- test: org.member.role.change.test.ts:role changed -->

- **WHEN** ctx.userId or ctx.apiKeyId is set AND ctx.orgId is set AND actor resolves to active principal with "Owner" or "Admin" role AND target userId exists in orgUsers for this org AND input.newRole exists as org-scoped system role AND (target not Owner OR count of Owners > 1)
- **THEN** verify actor role in {Owner, Admin}; resolve target orgUsers (404 if not in this org); resolve new role row by name and scope (404 if not found); if target is Owner and newRole !== "Owner" and count of active Owners <= 1, throw "Cannot demote last owner"; resolve target principal; soft-delete all org-scoped assignments (set deletedAt); insert new role assignment; update org_users.role to match new assignment; emit org.role_changed event; return {changed: true, targetUserId, orgId, previousRole, newRole}

#### Scenario: Requested role does not exist
<!-- test: org.member.role.change.test.ts:requested role does not exist -->

- **WHEN** role.name not found for (orgId, scopeKind="org", name=input.newRole)
- **THEN** throw Error "Role '{newRole}' does not exist in this org. Valid roles: Owner, Admin, Member, Billing, Compliance."

#### Scenario: Demotion of last owner blocked
<!-- test: org.member.role.change.test.ts:blocked — would demote last org owner -->

- **WHEN** input.newRole !== "Owner" AND target currently holds Owner role AND count of active Owner assignments === 1
- **THEN** throw Error "Cannot demote the last org owner. Promote another member to Owner first."

#### Scenario: Non-owner/admin attempts role change
<!-- test: org.member.role.change.test.ts -->

- **WHEN** actor's principal holds role not in {Owner, Admin}
- **THEN** throw Error "Forbidden: only org Owners and Admins can change member roles"

#### Scenario: Target not a member of this org (IDOR)
<!-- test: org.member.role.change.test.ts -->

- **WHEN** target userId has no org_users row for ctx.orgId
- **THEN** throw Error "Not found: target user is not a member of this org"

#### Scenario: No authenticated principal
<!-- test: org.member.role.change.test.ts -->

- **WHEN** ctx.userId is null AND ctx.apiKeyId is null
- **THEN** throw Error "Unauthorized: no authenticated principal"

#### Scenario: Missing orgId
<!-- test: org.member.role.change.test.ts -->

- **WHEN** ctx.orgId is null or empty
- **THEN** throw Error "Forbidden: orgId is required"

---

### Requirement: Organization settings read by org member

<!-- id: org.settings.read.orgSettingsReadHandler -->
<!-- entities: Organization -->
<!-- enforced: org.settings.read.orgSettingsReadHandler() -->
<!-- test: org.settings.read.test.ts -->

When an org member reads org.settings, the system SHALL fetch the organization row (name, slug, avatarUrl, website, industry, employeeSize, type) for ctx.orgId via tenant-scoped query (RLS limits to this org). Employee size and type fields are defensively coerced to contract's closed unions; invalid values fall back to null (for employeeSize) or "personal"/"business" (for type).

#### Scenario: Org member reads org profile
<!-- test: org.settings.read.test.ts:returned org settings -->

- **WHEN** ctx.orgId is set AND user is org member (implicit RLS check via withTenantDb)
- **THEN** query organizations by id=ctx.orgId; return {name, slug, avatarUrl, website, industry, employeeSize (validated union), type (validated to personal|business)}

#### Scenario: Organization not found
<!-- test: org.settings.read.test.ts -->

- **WHEN** ctx.orgId references a non-existent org
- **THEN** throw Error "Organization not found"

---

### Requirement: Organization settings written by org member

<!-- id: org.settings.write.orgSettingsWriteHandler -->
<!-- entities: Organization -->
<!-- enforced: org.settings.write.orgSettingsWriteHandler() -->
<!-- test: org.settings.write.test.ts -->

When an org member writes org.settings, the system SHALL perform a partial update on the organizations row for ctx.orgId (name, slug, avatarUrl, website, industry, employeeSize) via tenant-scoped transaction. Unspecified fields remain unchanged. Slug uniqueness is enforced by unique index organizations_slug_idx; duplicate slugs return a friendly error instead of a raw constraint violation. Null values clear nullable fields.

#### Scenario: Org member updates org name and slug
<!-- test: org.settings.write.test.ts:updated org settings -->

- **WHEN** ctx.orgId is set AND input.name or input.slug is defined AND (no other org has input.slug OR input.slug unchanged from current)
- **THEN** build updates dict from provided fields; attempt update on organizations WHERE id=ctx.orgId; on unique_violation (code 23505), throw "Slug "{slug}" is already in use by another organization"; re-fetch row; return updated {name, slug, avatarUrl, website, industry, employeeSize, type}

#### Scenario: Slug collision
<!-- test: org.settings.write.test.ts -->

- **WHEN** input.slug is claimed by another org (unique_violation)
- **THEN** throw Error "Slug "{slug}" is already in use by another organization"

#### Scenario: Organization not found
<!-- test: org.settings.write.test.ts -->

- **WHEN** ctx.orgId references a non-existent org
- **THEN** throw Error "Organization not found"

---

### Requirement: Workspace created by org member

<!-- id: workspace.create.workspaceCreateHandler -->
<!-- entities: Organization, Workspace, WorkspaceUser, Agent, DefaultRegistry, DefaultCapabilities, DefaultSkills -->
<!-- enforced: workspace.create.workspaceCreateHandler() -->
<!-- test: workspace.create.test.ts -->

When an authenticated user creates a workspace for ctx.orgId, the system SHALL create a workspace row with name and slug (unique per org), assign the creator as owner in workspace_users, bootstrap default agents (seedWorkspaceDefaultAgents), seed default registry (seedWorkspaceDefaultRegistry), seed first-party capability packs (seedWorkspaceDefaultCapabilities), seed editable builtin skill templates (seedWorkspaceDefaultSkills), emit workspace.created security event. Slug MUST be unique within the org (composite unique index on (orgId, slug)); duplicate slugs return a friendly error.

#### Scenario: User creates workspace within org
<!-- test: workspace.create.test.ts:workspace created successfully -->

- **WHEN** ctx.userId is set AND ctx.orgId is set AND no workspace exists with (orgId=ctx.orgId, slug=input.slug)
- **THEN** insert workspaces row (orgId, name, slug, createdByUserId, updatedByUserId); insert workspace_users row (workspaceId, userId, role="owner", joinedAt=now); call bootstrapWorkspaceAgents (idempotent seed); call seedWorkspaceDefaultRegistry (idempotent seed); call seedWorkspaceDefaultCapabilities (idempotent seed); call seedWorkspaceDefaultSkills (idempotent seed); emit workspace.created event; return {publicId, name, slug, orgSlug, createdAt as ISO string}

#### Scenario: Slug collision (race condition)
<!-- test: workspace.create.test.ts:slug conflict (race) -->

- **WHEN** unique_violation on (orgId, slug) during insert
- **THEN** throw Error "slug "{slug}" already in use for this tenant"

#### Scenario: Workspace slug already in use (pre-check)
<!-- test: workspace.create.test.ts -->

- **WHEN** workspace with (orgId=ctx.orgId, slug=input.slug) exists before insert
- **THEN** throw Error "slug "{slug}" already in use for this tenant"

#### Scenario: Unauthenticated user attempts workspace creation
<!-- test: workspace.create.test.ts -->

- **WHEN** ctx.userId is null
- **THEN** throw Error "workspace.create requires an authenticated user"

#### Scenario: Tenant not found
<!-- test: workspace.create.test.ts -->

- **WHEN** ctx.orgId references a non-existent org
- **THEN** throw Error "tenant not found"

---

### Requirement: Workspace invitation sent to invitee email

<!-- id: workspace.invite.send.workspaceInviteSendHandler -->
<!-- entities: Organization, Workspace, Invitation, User -->
<!-- depends_on: Workspace created by org member -->
<!-- enforced: workspace.invite.send.workspaceInviteSendHandler() -->
<!-- test: workspace.invite.send.test.ts -->

When an authenticated user sends a workspace invitation, the system SHALL upsert a pending invitation with a 7-day TTL, emit org.member_invited security event, and best-effort send an invitation email (non-fatal on failure). onConflictDoNothing + fallback select handles idempotency: if a pending invite for (orgId, email) exists, it is returned as-is without re-sending email.

#### Scenario: User sends workspace invitation
<!-- test: workspace.invite.send.test.ts -->

- **WHEN** ctx.userId is set AND input.email is provided AND input.role is provided
- **THEN** map role "member"/"admin"/"owner" to title-case org role; insert invitations (orgId, email, role, status="pending", invitedByUserId, expiresAt=now+7days) onConflictDoNothing; if no row inserted, select existing pending invite for (orgId, email); emit org.member_invited event (fire-and-forget); spawn best-effort email send (resolve inviter displayName, org name, build invite URL, send via sendEmail); return {id: publicId, status, expires_at as ISO string}

#### Scenario: Idempotent resubmission (pending invite exists)
<!-- test: workspace.invite.send.test.ts -->

- **WHEN** pending invitation already exists for (orgId, email)
- **THEN** select and return existing invitation (no email resent)

#### Scenario: Email send fails (non-fatal)
<!-- test: workspace.invite.send.test.ts -->

- **WHEN** sendEmail() raises error during best-effort send
- **THEN** log warning but do not fail handler; invitation created successfully; email may be manually resent

#### Scenario: Unauthenticated user attempts send
<!-- test: workspace.invite.send.test.ts -->

- **WHEN** ctx.userId is null
- **THEN** throw Error "workspace.invite.send requires an authenticated user"

---

### Requirement: Workspace members listed by workspace member

<!-- id: workspace.member.list.workspaceMemberListHandler -->
<!-- entities: Workspace, WorkspaceUser, User -->
<!-- enforced: workspace.member.list.workspaceMemberListHandler() -->
<!-- test: workspace.member.list.test.ts -->

When a workspace member lists members, the system SHALL return all active workspace_users for ctx.workspaceId (RLS-scoped) joined with users table to fetch email. Returns {id: publicId, email, role, joined_at as ISO string} for each member.

#### Scenario: Workspace member lists all members
<!-- test: workspace.member.list.test.ts -->

- **WHEN** ctx.workspaceId is set AND user is workspace member (implicit RLS check via withTenantDb)
- **THEN** select workspace_users for workspaceId=ctx.workspaceId, inner join users to get email; return array of {id: publicId, email, role, joined_at as ISO string}

---

### Requirement: Workspace settings read by workspace member

<!-- id: workspace.settings.read.workspaceSettingsReadHandler -->
<!-- entities: Workspace -->
<!-- enforced: workspace.settings.read.workspaceSettingsReadHandler() -->
<!-- test: workspace.settings.read.test.ts -->

When a workspace member reads workspace.settings, the system SHALL fetch the workspace row (name, slug, settings JSONB) for ctx.workspaceId via tenant-scoped query. Description is extracted from settings.description (defensively typed) and returned; other settings keys in the JSONB bag are preserved but not exposed in the contract.

#### Scenario: Workspace member reads workspace profile
<!-- test: workspace.settings.read.test.ts:returned workspace settings -->

- **WHEN** ctx.workspaceId is set AND user is workspace member (implicit RLS check via withTenantDb)
- **THEN** query workspaces by id=ctx.workspaceId; extract description from settings JSONB (default null if missing or not a string); return {name, slug, description}

#### Scenario: Workspace not found
<!-- test: workspace.settings.read.test.ts -->

- **WHEN** ctx.workspaceId references a non-existent workspace
- **THEN** throw Error "Workspace not found"

#### Scenario: No workspace context
<!-- test: workspace.settings.read.test.ts -->

- **WHEN** ctx.workspaceId is null or empty
- **THEN** throw Error "workspace.settings.read requires a workspace context"

---

### Requirement: Workspace settings written by workspace member

<!-- id: workspace.settings.write.workspaceSettingsWriteHandler -->
<!-- entities: Workspace -->
<!-- enforced: workspace.settings.write.workspaceSettingsWriteHandler() -->
<!-- test: workspace.settings.write.test.ts -->

When a workspace member writes workspace.settings, the system SHALL perform a partial update on the workspaces row for ctx.workspaceId. name and slug are columns; description is a key inside the settings JSONB bag (read-merge-write preserves other keys). Slug uniqueness is enforced per org (workspaces_org_slug_idx); duplicate slugs within the org return a friendly error. Null description clears the key from the JSONB bag.

#### Scenario: Workspace member updates name and description
<!-- test: workspace.settings.write.test.ts:updated workspace settings -->

- **WHEN** ctx.workspaceId is set AND (input.name or input.slug or input.description is defined) AND (slug not claimed by another workspace in this org OR unchanged)
- **THEN** fetch existing workspace; build updates dict; if description defined, merge into settings JSONB (null removes key); attempt update WHERE id=ctx.workspaceId; on unique_violation (code 23505), throw "Slug "{slug}" is already in use by another workspace in this org"; re-fetch row; return {name, slug, description}

#### Scenario: Slug collision within org
<!-- test: workspace.settings.write.test.ts -->

- **WHEN** input.slug claimed by another workspace in ctx.orgId (unique_violation)
- **THEN** throw Error "Slug "{slug}" is already in use by another workspace in this org"

#### Scenario: Workspace not found
<!-- test: workspace.settings.write.test.ts -->

- **WHEN** ctx.workspaceId references a non-existent workspace
- **THEN** throw Error "Workspace not found"

#### Scenario: No workspace context
<!-- test: workspace.settings.write.test.ts -->

- **WHEN** ctx.workspaceId is null or empty
- **THEN** throw Error "workspace.settings.write requires a workspace context"

---

### Requirement: User preferences read by authenticated user

<!-- id: user.preferences.read.userPreferencesReadHandler -->
<!-- entities: User, UserPreferences -->
<!-- enforced: user.preferences.read.userPreferencesReadHandler() -->
<!-- test: user.preferences.read.test.ts -->

When an authenticated user reads user.preferences, the system SHALL fetch the user_preferences row for ctx.userId via system-scoped query (no org/workspace scope — preferences are user-global). If no row exists, return schema defaults (fontSize="medium", density="comfortable", enterToSubmit=false, pendingPromptBehavior="queue", all model fields=null).

#### Scenario: User reads preferences (row exists)
<!-- test: user.preferences.read.test.ts:returned preferences -->

- **WHEN** ctx.userId is set AND user_preferences row exists for userId
- **THEN** fetch user_preferences row; return {fontSize, density, enterToSubmit, pendingPromptBehavior, defaultTextTier, defaultTextModel, defaultImageModel, defaultVideoModel}

#### Scenario: User reads preferences (no row, defaults returned)
<!-- test: user.preferences.read.test.ts:no row — returning schema defaults -->

- **WHEN** ctx.userId is set AND no user_preferences row exists
- **THEN** return schema defaults {fontSize: "medium", density: "comfortable", enterToSubmit: false, pendingPromptBehavior: "queue", defaultTextTier: null, defaultTextModel: null, defaultImageModel: null, defaultVideoModel: null}

#### Scenario: Unauthenticated user attempts read
<!-- test: user.preferences.read.test.ts -->

- **WHEN** ctx.userId is null
- **THEN** throw Error "user.preferences.read requires an authenticated user"

---

### Requirement: User preferences written by authenticated user

<!-- id: user.preferences.write.userPreferencesWriteHandler -->
<!-- entities: User, UserPreferences -->
<!-- enforced: user.preferences.write.userPreferencesWriteHandler() -->
<!-- test: user.preferences.write.test.ts -->

When an authenticated user writes user.preferences, the system SHALL upsert the user_preferences row (insert with schema defaults for non-nullable fields, or update only provided fields). The upsert targets userId as the conflict key (ON CONFLICT (userId) DO UPDATE). Non-nullable fields (fontSize, density, enterToSubmit, pendingPromptBehavior) default to schema values on first insert; nullable model fields are only set if explicitly provided (to distinguish "not set" from "null"). The handler re-reads the full row post-upsert to return canonical state.

#### Scenario: User updates preferences for first time (insert)
<!-- test: user.preferences.write.test.ts:preferences updated -->

- **WHEN** ctx.userId is set AND no user_preferences row exists AND input provides some fields
- **THEN** build insertValues with userId, createdByUserId, updatedByUserId, fontSize (or default "medium"), density (or default "comfortable"), enterToSubmit (or default false), pendingPromptBehavior (or default "queue"), plus any provided model fields; execute insert onConflictDoUpdate; re-read row; return full {fontSize, density, enterToSubmit, pendingPromptBehavior, defaultTextTier, defaultTextModel, defaultImageModel, defaultVideoModel}

#### Scenario: User updates existing preferences (update)
<!-- test: user.preferences.write.test.ts -->

- **WHEN** ctx.userId is set AND user_preferences row exists AND input provides some fields
- **THEN** build updateSet with only provided fields (undefined fields skipped) plus updatedByUserId=ctx.userId; execute upsert onConflictDoUpdate set updateSet; re-read row; return full state

#### Scenario: Unauthenticated user attempts write
<!-- test: user.preferences.write.test.ts -->

- **WHEN** ctx.userId is null
- **THEN** throw Error "user.preferences.write requires an authenticated user"

#### Scenario: Upserted row not found on re-read (internal error)
<!-- test: user.preferences.write.test.ts -->

- **WHEN** upsert succeeds but re-read returns no row (should never happen)
- **THEN** throw Error "user.preferences.write: upserted row not found on re-read"

---

### Invariant: Organization slug must be globally unique

<!-- entities: Organization -->
<!-- enforced: organization.create.organizationCreateHandler(), org.settings.write.orgSettingsWriteHandler() -->

The organizations table enforces slug uniqueness via unique index organizations_slug_idx. Any attempt to insert or update a slug already claimed by another org raises code 23505; the handlers translate this to a friendly error message ("slug already in use").

---

### Invariant: Workspace slug must be unique per organization

<!-- entities: Workspace -->
<!-- enforced: workspace.create.workspaceCreateHandler(), workspace.settings.write.workspaceSettingsWriteHandler() -->

The workspaces table enforces uniqueness of (orgId, slug) via composite unique index workspaces_org_slug_idx. Any attempt to create or update a slug already claimed by another workspace in the same org raises code 23505; the handlers translate this to a friendly error message.

---

### Invariant: Only org Owners can remove members or promote/demote role assignments

<!-- entities: Organization, Role, Principal, PrincipalRoleAssignment -->
<!-- enforced: org.member.remove.orgMemberRemoveHandler(), org.member.role.change.orgMemberRoleChangeHandler() -->

Both org.member.remove and org.member.role.change require the actor to hold the "Owner" or "Admin" role in the org (resolved via principal_role_assignments → roles with scopeKind="org", workspaceId IS NULL, deletedAt IS NULL). Failure to resolve such a role results in a Forbidden error.

---

### Invariant: Last org Owner cannot be removed or demoted

<!-- entities: Organization, Role, Principal, PrincipalRoleAssignment -->
<!-- enforced: org.member.remove.orgMemberRemoveHandler(), org.member.role.change.orgMemberRoleChangeHandler() -->

If a target user is the sole remaining active Owner of an org, the system SHALL block removal (org.member.remove) or demotion (org.member.role.change) to prevent org lockout. The guard counts active principal_role_assignments for the "Owner" org-scoped role (deletedAt IS NULL, workspaceId IS NULL) and raises an error if the count is ≤ 1 and the target holds that role.

---

### Invariant: Invitation email must match authenticated user's email (case-insensitive)

<!-- entities: Invitation, User -->
<!-- enforced: org.member.invite.accept.orgMemberInviteAcceptHandler() -->

When a user accepts an invitation, the system verifies that the user's email (from auth.users) matches the invitation.email case-insensitively (citext in DB). A mismatch is treated as "this invitation was not issued to your email address" and results in a Forbidden error.

---

### Invariant: Pending invitation occupies a seat until accepted, declined, or expired

<!-- entities: Invitation, Organization -->
<!-- enforced: org.member.add.orgMemberAddHandler() -->

Each pending invitation counts toward the org's seat capacity. When an invitation is created, assertSeatAvailable must pass. The seat is freed when the invitation transitions to "declined", "accepted" (converted to membership), or "expired". Idempotency via partial unique index on (orgId, email) WHERE status='pending' prevents duplicate pending invites.

---

### Invariant: Organization creator is automatically assigned as owner

<!-- entities: User, Organization, OrgUser, Principal, Role -->
<!-- enforced: organization.create.organizationCreateHandler() -->

When organization.create completes, the authenticated user (ctx.userId) is guaranteed to be an org member with:
- org_users row (orgId, userId, role="owner")
- principal row (orgId, kind="human", parentUserId=userId, status="active")
- principal_role_assignments row linking the principal to the org "Owner" role

No org exists without this initial owner assignment (transaction-atomic with org creation).

---

### Invariant: New org member principal created with no role assignments

<!-- entities: Principal, PrincipalRoleAssignment -->
<!-- enforced: org.member.invite.accept.orgMemberInviteAcceptHandler() (via provisionMemberPrincipal) -->

When a user accepts an invitation, provisionMemberPrincipal creates a least-privilege principal with status="active" and NO initial role assignments. The invited role is then explicitly assigned via a separate principal_role_assignments insert. This two-step process ensures members are denied everything until explicitly granted.

---

### Invariant: Role assignment soft-delete preserves audit trail

<!-- entities: PrincipalRoleAssignment -->
<!-- enforced: org.member.remove.orgMemberRemoveHandler(), org.member.role.change.orgMemberRoleChangeHandler() -->

When role assignments are revoked (due to member removal or role change), the system soft-deletes the principal_role_assignments row (sets deletedAt, deletedByUserId, updatedAt, updatedByUserId) rather than hard-deleting. This preserves the audit trail for compliance.

---

### Invariant: Organization IAM bootstrapped atomically with org creation

<!-- entities: Organization, Role, RoleGrant, Principal, PrincipalRoleAssignment -->
<!-- enforced: organization.create.organizationCreateHandler() (via bootstrapOrgIAM) -->

When an org is created, bootstrapOrgIAM runs inside the same transaction as the org insert. It:
- Upserts 7 system roles (4 org-level + 3 workspace-level) with deterministic public_ids
- Upserts the owner's principal
- Assigns the owner the org "Owner" role
- Seeds role_grants for all roles from every capability's defaultRoles

This is atomic; the org is never visible without the owner having full access.

---

### Invariant: Workspace creator is automatically assigned as owner

<!-- entities: User, Workspace, WorkspaceUser -->
<!-- enforced: workspace.create.workspaceCreateHandler() -->

When workspace.create completes, the authenticated user (ctx.userId) is guaranteed to be a workspace member with workspace_users row (workspaceId, userId, role="owner", joinedAt=now).

---

### Invariant: Workspace default resources seeded atomically

<!-- entities: Workspace, Agent, DefaultRegistry, DefaultCapabilities, DefaultSkills -->
<!-- enforced: workspace.create.workspaceCreateHandler() -->

When a workspace is created, the following idempotent seeds run (post-transaction, best-effort):
- seedWorkspaceDefaultRegistry: create/restore default MCP registry for the workspace
- seedWorkspaceDefaultCapabilities: create default first-party capability packs (documents/media)
- seedWorkspaceDefaultSkills: create editable copies of all builtin skill templates

These seeds allow agents to invoke capabilities and skills immediately without capability_not_installed errors.

---

### Invariant: Description field in workspace settings lives in JSONB bag

<!-- entities: Workspace -->
<!-- enforced: workspace.settings.read.workspaceSettingsReadHandler(), workspace.settings.write.workspaceSettingsWriteHandler() -->

The workspace description is not a dedicated column; it is stored as a key in the workspaces.settings JSONB bag alongside other settings keys (e.g., promptConfig). Read-merge-write logic ensures other keys are not clobbered when description is updated. Null description removes the key from the JSONB.

---

### Invariant: Legacy org_users.role kept in sync with IAM principal_role_assignments

<!-- entities: OrgUser, Principal, PrincipalRoleAssignment, Role -->
<!-- enforced: org.member.invite.accept.orgMemberInviteAcceptHandler(), org.member.role.change.orgMemberRoleChangeHandler() -->

The org_users.role column is a legacy denormalization. When role assignments change (via invite accept or role change), both the IAM layer (principal_role_assignments) and the legacy column are updated in the same transaction to maintain consistency for UI paths that still read org_users.role.

---

### Invariant: User preferences are user-global (no org or workspace scope)

<!-- entities: User, UserPreferences -->
<!-- enforced: user.preferences.read.userPreferencesReadHandler(), user.preferences.write.userPreferencesWriteHandler() -->

The user_preferences table has no org_id or workspace_id columns. Preferences apply to a user across all orgs and workspaces. Queries use withSystemDb (system-bypass) and target by userId only, not by tenant scope.

---

### Invariant: User preferences upsert targets userId as conflict key

<!-- entities: UserPreferences -->
<!-- enforced: user.preferences.write.userPreferencesWriteHandler() -->

The upsert uses ON CONFLICT (userId) DO UPDATE, making it idempotent and safe for concurrent writes by the same user. Non-nullable fields default to schema values on first insert; nullable model fields are only set if explicitly provided to distinguish "not set" from "null".

---

<!-- uncertainty: Workspace invitation send and org.member.add both create invitations rows in the invitations table with org-scoped lookup. workspace.invite.send maps role "member"/"admin"/"owner" to title-cased org roles at call time (e.g., "member" → "Member"). No explicit contract verification found for whether workspace invites are org-level or workspace-level; both invocations insert into the same org-level invitations table with the same status model (pending/accepted/declined/expired). Workspace-specific role assignment logic, if any, is deferred post-acceptance (not captured in workspace.invite.send handler itself). -->

<!-- deferred: workspace-agents.ts, workspace-registry-seed.ts, workspace-capability-seed.ts, skill-workspace-seed.ts (these are idempotent seed helpers called as post-transaction side-effects; their internal behaviors would require deep dives into each seed implementation) -->
