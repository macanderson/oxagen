# Spec: app-auth-onboarding

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: apps/app/src/app/(auth)/, apps/app/src/app/(onboarding)/, apps/app/src/lib/auth.ts, apps/app/src/lib/session.ts, apps/app/src/app/api/auth/[...all]/route.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Sign in with email and password
<!-- id: LoginForm.onSubmit -->
<!-- entities: User, Session -->
<!-- enforced: LoginForm.onSubmit() -->
<!-- test: requestResetAction.test.ts -->

User submits email and password on the sign-in form; the client calls `authClient.signIn.email()` which authenticates against the Better Auth backend. On success, a user session is established and the user is redirected to the home page. On error, a user-friendly error message is displayed.

#### Scenario: Valid credentials
<!-- test: LoginForm.onSubmit -->
- **WHEN** user enters valid email and password (min 8 characters) and submits the sign-in form
- **THEN** `authClient.signIn.email()` succeeds, the session is established, and the user is redirected to `/`

#### Scenario: Invalid credentials
<!-- test: LoginForm.onSubmit -->
- **WHEN** user enters an email with no matching account or an incorrect password and submits
- **THEN** `authClient.signIn.email()` returns an error, the error message is displayed to the user, and no redirect occurs

---

### Requirement: Sign up with email and password
<!-- id: LoginForm.onSubmit -->
<!-- entities: User, Session -->
<!-- enforced: LoginForm.onSubmit() -->
<!-- test: LoginForm.test.tsx -->

User submits a name, email, and password on the sign-up form; the client calls `authClient.signUp.email()` which creates a new user account in Better Auth. On success, the user session is established and the user is redirected to the organization creation page (`/new-organization`). On error, a user-friendly error message is displayed.

#### Scenario: Valid sign-up with unique email
<!-- test: LoginForm.onSubmit -->
- **WHEN** user enters a unique email, name, and password (min 8 characters) and submits the sign-up form
- **THEN** `authClient.signUp.email()` creates the user account, a session is established, and the user is redirected to `/new-organization`

#### Scenario: Duplicate email
<!-- test: LoginForm.onSubmit -->
- **WHEN** user enters an email that already exists in the system and submits the sign-up form
- **THEN** `authClient.signUp.email()` returns an error, the error message is displayed, and no redirect occurs

#### Scenario: Password too short
<!-- test: LoginForm.onSubmit -->
- **WHEN** user enters a password shorter than 8 characters
- **THEN** the browser's HTML5 validation (`minLength={8}`) prevents form submission

---

### Requirement: Authenticate via OAuth (Google or GitHub)
<!-- id: OAuthButtons.handle -->
<!-- entities: User, Session -->
<!-- enforced: OAuthButtons.handle() -->

User clicks "Continue with Google" or "Continue with GitHub" button. The client calls `authClient.signIn.social()` with the provider and optional `callbackURL`, initiating an OAuth redirect flow. After successful authentication and authorization at the OAuth provider, the user is redirected back to the app at the specified callback URL (default `/`). Better Auth populates the new user's name, email, and avatar from the OAuth profile.

#### Scenario: Google OAuth successful sign-in
<!-- test: OAuthButtons.handle -->
- **WHEN** user clicks "Continue with Google" and authorizes the app at Google's OAuth consent screen
- **THEN** `authClient.signIn.social({ provider: "google", callbackURL: "/" })` completes, the session is established with the Google profile data, and the user is redirected to `/`

#### Scenario: GitHub OAuth successful sign-in
<!-- test: OAuthButtons.handle -->
- **WHEN** user clicks "Continue with GitHub" and authorizes the app at GitHub's OAuth consent screen
- **THEN** `authClient.signIn.social({ provider: "github", callbackURL: "/" })` completes, the session is established with the GitHub profile data, and the user is redirected to `/`

#### Scenario: OAuth sign-up (new account created)
<!-- test: OAuthButtons.handle -->
- **WHEN** user clicks an OAuth button and the provider email does not exist in the system
- **THEN** Better Auth creates a new user account, links the OAuth provider, populates name/email/avatar from the provider profile, and establishes a session

---

### Requirement: Request password reset via email
<!-- id: requestResetAction -->
<!-- entities: User, PasswordResetToken -->
<!-- enforced: requestResetAction() -->
<!-- test: requestResetAction.test.ts -->

User enters their email address and submits the "Forgot password" form. The server action `requestResetAction()` validates the email format, then calls `auth.api.requestPasswordReset()` to trigger a password-reset email from Better Auth. The email contains a one-time link with a token valid for 1 hour. Regardless of whether an account exists for the submitted email, the UI always displays a neutral success message (anti-enumeration — never confirm or deny account existence).

#### Scenario: Valid email with existing account
<!-- test: requestResetAction.test.ts -->
- **WHEN** user enters a valid email for an account that exists and submits the forgot-password form
- **THEN** `auth.api.requestPasswordReset()` sends a reset email with a one-time token, and the UI displays the success message

#### Scenario: Valid email with no account
<!-- test: requestResetAction.test.ts -->
- **WHEN** user enters a valid email that does not match any account and submits the forgot-password form
- **THEN** `auth.api.requestPasswordReset()` finds no account and skips email dispatch, but the UI still displays the neutral success message (anti-enumeration)

#### Scenario: Invalid email format
<!-- test: requestResetAction.test.ts -->
- **WHEN** user enters an invalid email (e.g., empty, missing @, malformed) and submits the forgot-password form
- **THEN** Zod validation fails, `requestResetAction()` returns `{ ok: false, error: "Enter a valid email address" }`, and the error message is displayed

#### Scenario: API error during email dispatch
<!-- test: requestResetAction.test.ts -->
- **WHEN** `auth.api.requestPasswordReset()` throws an error (e.g., email service outage)
- **THEN** the exception is swallowed, the action returns `{ ok: true }`, and the success message is displayed (anti-enumeration prevents error leakage)

#### Scenario: Environment config missing
<!-- test: requestResetAction.test.ts -->
- **WHEN** `loadEnv()` fails to resolve `BETTER_AUTH_URL` (e.g., misconfigured environment)
- **THEN** `requestResetAction()` logs the error and returns `{ ok: false, error: "Password reset is temporarily unavailable" }` before attempting the email dispatch

---

### Requirement: Reset password with one-time token
<!-- id: resetPasswordAction -->
<!-- entities: User, PasswordResetToken -->
<!-- enforced: resetPasswordAction() -->
<!-- test: resetPasswordAction.test.ts -->

User arrives at `/reset-password?token=<TOKEN>` from an email link, enters a new password and confirmation, and submits the reset-password form. The server action `resetPasswordAction()` validates the token, password format, and confirmation match, then calls `auth.api.resetPassword()`. On success, the token is invalidated (single-use) and all active sessions for the user are revoked. The UI displays a success message and redirects to `/login` after 1.5 seconds.

#### Scenario: Valid token and matching passwords
<!-- test: resetPasswordAction.test.ts -->
- **WHEN** user provides a valid, unexpired reset token and enters matching new passwords (min 8, max 128 chars)
- **THEN** `auth.api.resetPassword()` accepts the token, updates the credential, revokes all active sessions, and returns `{ ok: true }`

#### Scenario: Token is missing from URL
<!-- test: resetPasswordAction.test.ts -->
- **WHEN** user navigates to `/reset-password` without a `?token=` query parameter
- **THEN** the form initialization detects an empty token and displays the "invalid or has expired" error UI with a link back to `/forgot-password`

#### Scenario: Token is invalid or expired
<!-- test: resetPasswordAction.test.ts -->
- **WHEN** user submits the reset form with an invalid, expired, or already-used token
- **THEN** `auth.api.resetPassword()` raises an error containing "token" or "INVALID_TOKEN", the action catches it and returns a friendly message, and the "invalid or has expired" error UI is displayed

#### Scenario: Password too short
<!-- test: resetPasswordAction.test.ts -->
- **WHEN** user submits a password shorter than 8 characters
- **THEN** Zod validation fails before the API call and returns `{ ok: false, error: "Password must be at least 8 characters" }`

#### Scenario: Password too long
<!-- test: resetPasswordAction.test.ts -->
- **WHEN** user submits a password longer than 128 characters
- **THEN** Zod validation fails before the API call and returns `{ ok: false, error: "Password must be at most 128 characters" }`

#### Scenario: Passwords do not match
<!-- test: resetPasswordAction.test.ts -->
- **WHEN** user enters a new password and a different confirmation password
- **THEN** client-side form validation and server-side check both detect the mismatch and return `{ ok: false, error: "Passwords do not match" }`

#### Scenario: Generic API error
<!-- test: resetPasswordAction.test.ts -->
- **WHEN** `auth.api.resetPassword()` raises an error not related to the token or password format
- **THEN** the error message is captured (without logging the password), a generic message is returned, and the "error" UI state is displayed

---

### Requirement: Establish user session on login
<!-- id: getSession -->
<!-- entities: User, Session -->
<!-- enforced: getSession() -->

After a successful sign-in or sign-up, Better Auth establishes a session (stored as an HTTP-only cookie). The `getSession()` function in `session.ts` (wrapped with React `cache()` for per-request memoization) retrieves the session via `auth.api.getSession()`. Every request that needs the authenticated user calls `getSession()` once, and all downstream RSCs on that request receive the cached result.

#### Scenario: Valid session cookie present
<!-- test: getSession() -->
- **WHEN** an HTTP request is received with a valid Better Auth session cookie
- **THEN** `auth.api.getSession({ headers })` retrieves the session, returns the authenticated user data, and the result is cached for the duration of the request

#### Scenario: No session cookie
<!-- test: getSession() -->
- **WHEN** an HTTP request is received without a session cookie (not signed in)
- **THEN** `auth.api.getSession({ headers })` returns `null`, indicating no authenticated user

#### Scenario: Memoization within single request
<!-- test: getSession() -->
- **WHEN** multiple RSCs on the same request call `getSession()`
- **THEN** React `cache()` returns the same result without repeating the DB lookup, reducing overhead

---

### Requirement: Redirect unauthenticated users to login
<!-- id: getSessionOrRedirect -->
<!-- entities: User, Session -->
<!-- enforced: getSessionOrRedirect() -->

Pages that require authentication call `getSessionOrRedirect()`. If a session exists, the function returns the session. If no session is found, the function redirects to `/login` (or a specified alternate URL).

#### Scenario: Authenticated user accesses protected page
<!-- test: getSessionOrRedirect() -->
- **WHEN** an authenticated user with a valid session accesses a protected page (e.g., `/new-organization`)
- **THEN** `getSessionOrRedirect()` returns the user's session, and the page renders

#### Scenario: Unauthenticated user accesses protected page
<!-- test: getSessionOrRedirect() -->
- **WHEN** an unauthenticated user (no session cookie) tries to access a protected page
- **THEN** `getSessionOrRedirect()` triggers a redirect to `/login` (or custom `redirectTo` parameter), halting further page computation

#### Scenario: Custom redirect destination
<!-- test: getSessionOrRedirect() -->
- **WHEN** a protected page calls `getSessionOrRedirect("/some-other-path")` and the user is not authenticated
- **THEN** the redirect points to `/some-other-path` instead of the default `/login`

---

### Requirement: Audit failed sign-in attempts
<!-- id: POST -->
<!-- entities: User, Session, SecurityEvent -->
<!-- enforced: POST() -->
<!-- test: route.test.ts (if exists) -->

The `POST` route handler at `/api/auth/[...all]/` wraps the Better Auth handler to intercept failed authentication responses. When a sign-in attempt (on paths `/sign-in/email`, `/sign-in/social`, or `/callback/*`) returns 401, 403, or 429 (rate limit), an `auth.sign_in_failed` security event is emitted with the requester's IP and user-agent for SOC2 audit compliance.

#### Scenario: Failed sign-in attempt (invalid credentials)
<!-- test: POST() -->
- **WHEN** a user submits invalid credentials to `/sign-in/email` and Better Auth responds with 401
- **THEN** the POST wrapper detects the 401 status and calls `emitSecurityEvent({ eventType: "auth.sign_in_failed", ... })` with the requester's IP and user-agent

#### Scenario: Forbidden sign-in (403)
<!-- test: POST() -->
- **WHEN** Better Auth returns 403 (e.g., account disabled or rate-limit gate) on a sign-in path
- **THEN** the POST wrapper emits an `auth.sign_in_failed` security event

#### Scenario: Rate limit exceeded (429)
<!-- test: POST() -->
- **WHEN** a user exceeds the sign-in rate limit and Better Auth responds with 429 on a sign-in path
- **THEN** the POST wrapper emits an `auth.sign_in_failed` security event to record the brute-force attempt for SOC2 CC6

#### Scenario: Non-sign-in paths pass through unchanged
<!-- test: POST() -->
- **WHEN** a request to `/sign-up/email` or other non-sign-in path returns 401
- **THEN** the POST wrapper does not emit an event and passes the response through unchanged

#### Scenario: Successful response on sign-in path
<!-- test: POST() -->
- **WHEN** a user successfully signs in (200 response) on a sign-in path
- **THEN** the POST wrapper passes the response through unchanged with no event emission

---

### Requirement: Create organization on first signup
<!-- id: createOrgAction -->
<!-- entities: Organization, Workspace, User, OrgUser, WorkspaceUser, BillingProfile, IAMRole -->
<!-- enforced: createOrgAction() -->
<!-- depends_on: Sign up with email and password, Establish user session on login -->
<!-- test: createOrgAction.test.ts -->

After a user signs up, they land on the `/new-organization` page, which requires an authenticated session. The `NewOrgForm` collects organization details (name, slug, type, industry, billing address, avatar) and submits a FormData payload to `createOrgAction()`. The action validates the form, enforces the `organization.create` and `workspace.create` capability contracts (same validation rules as the API), creates an organization row, associates the creator as owner, creates a default workspace, assigns the user as workspace owner, bootstraps IAM state, and optionally creates a billing profile. On success, the user is redirected into the new org/workspace.

#### Scenario: Valid organization creation with business type
<!-- test: createOrgAction.test.ts -->
- **WHEN** a newly signed-up user submits a valid organization form with type "business", name, slug, website, industry, and billing email
- **THEN** `createOrgAction()` validates all fields through the capability contract, creates the org and default workspace in a transaction, associates the user as owner in both, bootstraps IAM roles, optionally creates a billing profile if address is complete, and returns `{ ok: true, orgSlug, workspaceSlug }`

#### Scenario: Valid organization creation with personal type
<!-- test: createOrgAction.test.ts -->
- **WHEN** a newly signed-up user submits a valid organization form with type "personal", name, and slug (website/industry hidden for personal)
- **THEN** `createOrgAction()` skips business-specific fields, creates the org and default workspace, and returns success

#### Scenario: Slug already taken
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user submits a slug that matches an existing organization's slug (unique constraint violation on `organizations_slug_idx`)
- **THEN** the database INSERT fails with error code 23505, the action catches it and returns `{ ok: false, error: "Slug \"<slug>\" is already taken" }`

#### Scenario: Missing required field
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user submits a form missing a required field (e.g., empty name or slug)
- **THEN** Zod validation on the form schema fails before capability validation, and the action returns `{ ok: false, error: "<field> message" }`

#### Scenario: Invalid capability contract field
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user submits a slug with invalid characters (not matching `/^[a-z0-9-]+$/`) or a slug shorter than 2 characters
- **THEN** the `organization.create` capability contract validation fails, and the action returns `{ ok: false, error: "<field> message" }`

#### Scenario: Partial billing address (incomplete)
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user fills in some but not all required billing address fields (line1, city, postalCode, country)
- **THEN** the action skips creating a billing profile (treats it as if the address was not submitted), and only creates the org and workspace

#### Scenario: Complete billing address
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user submits all required billing address fields (line1, city, postalCode, country) plus optional line2 and region
- **THEN** the action creates an `org_billing_profiles` row with normalized address data (country/region uppercase for US)

#### Scenario: Avatar upload from form
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user uploads an avatar via the AvatarUpload component, which produces a blob URL (`*.public.blob.vercel-storage.com`), and submits the form
- **THEN** `resolveOrgAvatarUrl()` detects the owned blob URL and keeps it as-is; the org is created with `avatarUrl` set to that URL

#### Scenario: Avatar from OAuth profile
<!-- test: createOrgAction.test.ts -->
- **WHEN** the form is prefilled with a user's Google or GitHub avatar URL and the user submits without changing it
- **THEN** `resolveOrgAvatarUrl()` checks if the URL is ingestible (trusted OAuth domain), calls `ingestImageFromUrl()` to copy it into the app's blob store, and stores the new URL; if ingestion fails, falls back to the external URL

#### Scenario: Avatar URL is untrusted
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user submits a form with an arbitrary external URL as the avatar (not blob.vercel-storage.com, not a trusted OAuth domain)
- **THEN** `resolveOrgAvatarUrl()` drops it (returns `null`) to prevent SSRF / stored-reference risks

#### Scenario: Empty avatar URL
<!-- test: createOrgAction.test.ts -->
- **WHEN** a user submits the form with no avatar selected or an empty string
- **THEN** `resolveOrgAvatarUrl()` returns `null`, and the org is created with `avatarUrl: null`

#### Scenario: Free credits granted after org creation
<!-- test: createOrgAction.test.ts -->
- **WHEN** the org and workspace are created successfully
- **THEN** `grantFreeCredits(orgId)` is called outside the transaction to award the non-expiring signup credit ($5)

#### Scenario: Billing credits grant fails
<!-- test: createOrgAction.test.ts -->
- **WHEN** `grantFreeCredits()` throws an error after the org is already created
- **THEN** the error is logged but swallowed, org creation returns `{ ok: true }`, and the user proceeds into the workspace (the grant is recoverable)

#### Scenario: Redirect into created organization
<!-- test: createOrgAction.test.ts -->
- **WHEN** org creation succeeds and returns `{ ok: true, orgSlug, workspaceSlug }`
- **THEN** the form's `onSubmit` calls `window.location.assign(`/${orgSlug}/${workspaceSlug}`)` for a full-page hard navigation into the new org context (avoiding App Router cache race)

---

### Requirement: Prefill organization form with authenticated user profile
<!-- id: NewTenantPage -->
<!-- entities: User, Organization -->
<!-- enforced: NewTenantPage() -->

The `/new-organization` page calls `getSessionOrRedirect()` to ensure the user is authenticated, then builds form prefill data from the user's profile (name, email, avatar). If the user signed up via OAuth (Google or GitHub), `getLinkedSocialProvider()` identifies the provider so the form displays an attribution message (e.g., "Prefilled from your Google account").

#### Scenario: Sign-up via email/password
<!-- test: NewTenantPage() -->
- **WHEN** a user who signed up with email/password navigates to `/new-organization`
- **THEN** the form is seeded with the user's stored name and email, `getLinkedSocialProvider()` returns `null`, and no attribution message is shown

#### Scenario: Sign-up via Google OAuth
<!-- test: NewTenantPage() -->
- **WHEN** a user who signed up via Google OAuth navigates to `/new-organization`
- **THEN** the form is prefilled with the user's Google profile name, email, and avatar, `getLinkedSocialProvider()` returns "google", and the attribution message reads "Prefilled from your Google account — edit anything below"

#### Scenario: Sign-up via GitHub OAuth
<!-- test: NewTenantPage() -->
- **WHEN** a user who signed up via GitHub OAuth navigates to `/new-organization`
- **THEN** the form is prefilled with the user's GitHub profile name, email, and avatar, `getLinkedSocialProvider()` returns "github", and the attribution message reads "Prefilled from your GitHub account — edit anything below"

#### Scenario: Suggested business name from email domain
<!-- test: NewTenantPage() -->
- **WHEN** a user selects organization type "business" and the prefill logic has a recognized email domain (e.g., `user@company.com`)
- **THEN** the form suggests a business name derived from the domain and displays it in the name field

---

### Requirement: Validate organization slug format and auto-derive from name
<!-- id: NewOrgForm -->
<!-- entities: Organization -->
<!-- enforced: NewOrgForm() -->

The organization form derives the slug from the user's entered name via `slugify()` (lowercasing, removing special chars, replacing spaces with hyphens, capping at 40 chars). The slug field is auto-populated as the user types the name, but the user can hand-edit the slug. Clearing the slug field back to empty re-arms the auto-derivation, so a name change after clearing always repopulates the slug. The slug is validated against the capability contract rules (`/^[a-z0-9-]+$/`, 2–40 chars) on the server action.

#### Scenario: Auto-derive slug from name
<!-- test: NewOrgForm -->
- **WHEN** a user types "My Company LLC" in the name field
- **THEN** the slug field auto-populates with "my-company-llc" via `slugify()`, capped at 40 chars

#### Scenario: Manual slug edit
<!-- test: NewOrgForm -->
- **WHEN** a user types a name, then hand-edits the slug field to a custom value
- **THEN** the `slugManuallyEdited` flag is set; further name changes do not overwrite the slug

#### Scenario: Clear slug field to re-arm auto-derivation
<!-- test: NewOrgForm -->
- **WHEN** a user manually edited the slug, then clears it back to empty
- **THEN** `slugManuallyEdited` is reset; the next name change repopulates the slug via `slugify()`

#### Scenario: Toggle organization type with name following
<!-- test: NewOrgForm -->
- **WHEN** a user changes the organization type from "business" to "personal" (or vice versa)
- **THEN** if the user has not manually edited the name, the suggested name for the new type is loaded; if the slug has not been manually edited, the slug is re-derived from the new name

---

### Invariant: Session is cached per HTTP request
<!-- entities: Session, User -->
<!-- enforced: getSession() -->

`getSession()` is wrapped with React `cache()`, which memoizes the result within a single HTTP request lifecycle. Subsequent calls to `getSession()` on the same request return the cached value without repeating the session lookup.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Password minimum length is 8 characters
<!-- entities: User -->
<!-- enforced: LoginForm.minLength={8}, resetPasswordAction, resetPasswordSchema -->

All password inputs (sign-up, reset-password) enforce a minimum of 8 characters. The LoginForm HTML input uses `minLength={8}` for browser validation; the `resetPasswordSchema` Zod validator enforces `.min(8)`.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Password maximum length is 128 characters
<!-- entities: User -->
<!-- enforced: resetPasswordSchema, resetPasswordForm input maxLength={128} -->

Password fields are capped at 128 characters. The reset-password form HTML inputs use `maxLength={128}`, and the `resetPasswordSchema` Zod validator enforces `.max(128)`.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Password reset tokens are single-use and expire in 1 hour
<!-- entities: PasswordResetToken -->
<!-- enforced: auth.api.resetPassword() -->

Better Auth generates password-reset tokens that are valid for exactly 1 hour and are consumed (invalidated) on the first successful reset. Attempting to reuse an expired or already-used token returns an error.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: All active sessions are revoked on password reset
<!-- entities: User, Session -->
<!-- enforced: resetPasswordSchema comment: revokeSessionsOnPasswordReset is true -->
<!-- enforced: auth.api.resetPassword() -->

When a password is successfully reset via `auth.api.resetPassword()`, all active sessions for that user are invalidated. The user must sign in again with the new password to establish a new session.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Failed sign-in attempts are audited for SOC2 CC6
<!-- entities: SecurityEvent, User -->
<!-- enforced: POST() emitSecurityEvent() -->

Every failed sign-in attempt (401, 403, or 429 response) on sign-in paths triggers an `auth.sign_in_failed` security event. These events include the requester's IP and user-agent and are persisted for audit and brute-force detection.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Organization slug must be unique across the platform
<!-- entities: Organization -->
<!-- enforced: createOrgAction, organizations_slug_idx unique index -->

Every organization has a unique slug (`organizations_slug_idx`). Attempting to create an organization with a slug that already exists fails with a 23505 (unique constraint) violation.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Organization slug follows kebab-case pattern
<!-- entities: Organization -->
<!-- enforced: organization.create contract, createOrgAction -->

Organization slugs must match `/^[a-z0-9-]+$/` and be 2–40 characters long. Slugs are derived from the org name via `slugify()` but can be hand-edited; all slugs are validated server-side against the capability contract.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Org creator is automatically owner of org and default workspace
<!-- entities: Organization, Workspace, User, OrgUser, WorkspaceUser, IAMRole -->
<!-- enforced: createOrgAction rows 189, 210 -->

When `createOrgAction()` creates an organization, it automatically inserts the creating user as owner in both `org_users` (role='owner') and `workspace_users` (role='owner') for the default workspace. This ensures the creator has full administrative rights.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: A default workspace is created with every organization
<!-- entities: Organization, Workspace -->
<!-- enforced: createOrgAction line 199 -->

Every organization created via `createOrgAction()` automatically receives a "Default" workspace with slug "default". This ensures the user lands in a workspace after signup without additional onboarding steps.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Billing profile is optional; created only when all required address fields are present
<!-- entities: BillingProfile -->
<!-- enforced: createOrgAction lines 148–164 -->

A billing profile row is only created if the user provides either a `billingEmail` or a complete billing address (line1, city, postalCode, country). Partial address data is ignored. If created, the profile includes optional fields (line2, region) and normalizes country/region to uppercase.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: US state codes are uppercase; non-US regions are free-text
<!-- entities: BillingProfile -->
<!-- enforced: createOrgAction lines 157–159 -->

When a billing address is submitted, the `region` field is uppercased only if the country is "US" (e.g., "CA" for California). Non-US addresses preserve the user's case (e.g., "Québec", "Ontario").

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Owned blob URLs are never re-ingested; external OAuth URLs are copied into blob storage
<!-- entities: Avatar -->
<!-- enforced: resolveOrgAvatarUrl() lines 44–48 -->

Avatar URLs are categorized:
- If the URL is already hosted on Vercel's blob storage (`*.public.blob.vercel-storage.com`), it is kept as-is (the app already owns it).
- If the URL is from a trusted OAuth provider (Google, GitHub), `ingestImageFromUrl()` copies it into the app's blob store to ensure data ownership.
- Arbitrary external URLs are dropped (never fetched or stored) to prevent SSRF and stored-reference risks.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Anti-enumeration on forgot-password: same response regardless of account existence
<!-- entities: User -->
<!-- enforced: requestResetAction line 85 -->

`requestResetAction()` always returns `{ ok: true }` regardless of whether the submitted email matches a user account. Errors are swallowed (lines 72–82). This prevents timing attacks or account enumeration (e.g., "user with this email exists" leakage).

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: IAM state is bootstrapped atomically with organization creation
<!-- entities: Organization, IAMRole, RoleGrant -->
<!-- enforced: createOrgAction line 218, bootstrapOrgIAM() -->

When `createOrgAction()` creates an organization within a transaction, `bootstrapOrgIAM()` is called to initialize the complete IAM state: system roles, owner principal, owner role assignment, and default role grants. This atomic bootstrap ensures the org is never left in a partially initialized IAM state.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Form submission never logs password values
<!-- entities: User -->
<!-- enforced: resetPasswordAction line 16 comment, resetPasswordAction line 78 -->

In `resetPasswordAction()`, the error-handling logic captures error messages but explicitly avoids logging the password value (line 16 comment, line 78). This prevents accidental password exposure in logs or error reports.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Organization creation uses system-level database access (bypasses RLS)
<!-- entities: Organization -->
<!-- enforced: createOrgAction line 4 comment (OXA-1515), createOrgAction line 167 withSystemDb() -->

The `createOrgAction()` function uses `withSystemDb()` to bypass Row-Level Security during org creation. This is necessary because no organization or workspace exists yet at call time (the action IS what creates the first tenant identity). The action is protected by requiring the user to be authenticated via `getSessionOrRedirect()`.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Form data is coerced to not include blank strings in optional columns
<!-- entities: Organization -->
<!-- enforced: createOrgAction line 79, nonEmpty() function -->

The `nonEmpty()` helper function (line 79) trims whitespace and returns `undefined` for empty or blank-only strings. This prevents empty strings from being written to optional database columns, maintaining proper `NULL` semantics.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Unhandled errors on create organization log real cause and return generic message
<!-- entities: Organization -->
<!-- enforced: createOrgAction lines 248–259 -->

Unhandled exceptions during organization creation are logged with the real error for diagnosis (line 258), but a generic, safe message ("Failed to create organization. Please try again.") is returned to the user. This prevents information leakage.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- deferred: apps/app/src/components/org/new-organization-form.tsx (lines 150–), apps/app/src/components/auth/login-form.test.tsx, apps/app/src/components/auth/forgot-password-form.test.tsx, apps/app/src/components/auth/reset-password-form.test.tsx, apps/app/src/lib/oauth-prefill.ts, apps/app/src/lib/linked-provider.ts (brief verification of prefill logic) -->
