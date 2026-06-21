# Spec: handlers-billing-apikeys

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: billing.credits.purchase.ts, billing.subscription.read.ts, billing.subscription.upgrade.start.ts, api.key.create.ts, api.key.revoke.ts, api.key.rotate.ts, lib/api-key-authz.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: reject billing action without authenticated principal
<!-- id: billingCreditsPurchaseHandler.handler -->
<!-- entities: User, Organization -->
<!-- enforced: billing.credits.purchase.ts:13-19 -->
<!-- test: billing.credits.purchase.test.ts -->

A billing.credits.purchase or billing.subscription.upgrade.start request SHALL be rejected if the caller has neither a userId nor an apiKeyId. The request MUST fail with an Unauthorized error.

#### Scenario: user-initiated request with no authenticated principal
- **WHEN** ctx.userId is null AND ctx.apiKeyId is null during billing.credits.purchase
- **THEN** throw Error("Unauthorized: no authenticated principal")

#### Scenario: API-key-initiated request with no authenticated principal
- **WHEN** ctx.userId is null AND ctx.apiKeyId is null during billing.subscription.upgrade.start
- **THEN** throw Error("Unauthorized: no authenticated principal")

---

### Requirement: reject billing action without org scope
<!-- id: billingCreditsPurchaseHandler.handler -->
<!-- entities: Organization -->
<!-- enforced: billing.credits.purchase.ts:20-23 -->
<!-- test: billing.credits.purchase.test.ts -->

A billing.credits.purchase or billing.subscription.upgrade.start request SHALL be rejected if ctx.orgId is missing. Billing actions are org-scoped and cannot proceed without organizational context.

#### Scenario: credits purchase request without orgId
- **WHEN** ctx.orgId is null or empty during billing.credits.purchase, regardless of authentication
- **THEN** throw Error("Forbidden: orgId is required to purchase usage credits")

#### Scenario: subscription upgrade request without orgId
- **WHEN** ctx.orgId is null or empty during billing.subscription.upgrade.start, regardless of authentication
- **THEN** throw Error("Forbidden: orgId is required to start a subscription upgrade")

---

### Requirement: create Stripe Checkout session for usage credit purchase
<!-- id: billingCreditsPurchaseHandler.handler -->
<!-- entities: Organization, Stripe -->
<!-- depends_on: reject billing action without authenticated principal, reject billing action without org scope -->
<!-- enforced: billing.credits.purchase.ts:30-35 -->
<!-- test: billing.credits.purchase.test.ts -->

When an authenticated caller scoped to an org requests a usage credit purchase, the handler SHALL convert the dollar amount to cents and call createUsageCreditCheckout, returning a Stripe Checkout URL plus grant and price details.

#### Scenario: successful credits purchase checkout session creation
- **WHEN** ctx has valid userId/apiKeyId and orgId, input.amountUsd is ≥ 5
- **THEN** convert amountUsd to grantCents (multiply by 100), call createUsageCreditCheckout(orgId, grantCents, successUrl, cancelUrl), return { url, grantCents, priceCents, percent }

#### Scenario: checkout creation fails
- **WHEN** createUsageCreditCheckout throws any error
- **THEN** log error and re-throw the exception

---

### Requirement: emit audit event on successful credits purchase
<!-- id: emitSecurityEvent.call -->
<!-- entities: Organization, User -->
<!-- depends_on: create Stripe Checkout session for usage credit purchase -->
<!-- enforced: billing.credits.purchase.ts:37-48 -->
<!-- test: billing.credits.purchase.test.ts -->

After successfully creating a Stripe Checkout session for credits purchase, the handler SHALL emit a billing.checkout_initiated security event (fire-and-forget) with the acting principal, org, and request metadata.

#### Scenario: audit event emitted after successful checkout
- **WHEN** createUsageCreditCheckout returns successfully
- **THEN** call emitSecurityEvent with eventType: "billing.checkout_initiated", actorUserId, orgId, workspaceId, capability: "billing.credits.purchase", outcome: "success"

---

### Requirement: read subscription and credit balance for authenticated org member
<!-- id: billingSubscriptionReadHandler.handler -->
<!-- entities: Organization, Subscription, CreditBalance -->
<!-- enforced: billing.subscription.read.ts:29-34 -->
<!-- test: billing.subscription.read.test.ts -->

A billing.subscription.read request SHALL require an authenticated principal (userId or apiKeyId) and org scope. The handler fetches the active subscription, plan slug, and credit balance concurrently.

#### Scenario: request without authenticated principal
- **WHEN** ctx.userId is null AND ctx.apiKeyId is null
- **THEN** throw Error("Unauthorized: no authenticated principal")

#### Scenario: request without orgId
- **WHEN** ctx.orgId is null or empty, regardless of authentication
- **THEN** throw Error("Forbidden: orgId is required to read billing data")

#### Scenario: successful subscription and balance fetch
- **WHEN** ctx has valid userId/apiKeyId and orgId
- **THEN** fetch subscription where orgId matches and status is in [trialing, active, past_due, paused], join plan to get slug, fetch creditBalance for orgId, return both concurrently

---

### Requirement: include current period token usage when subscription is active
<!-- id: billingSubscriptionReadHandler.handler -->
<!-- entities: Organization, ClickHouse -->
<!-- depends_on: read subscription and credit balance for authenticated org member -->
<!-- enforced: billing.subscription.read.ts:84-106 -->
<!-- test: billing.subscription.read.test.ts -->

If a subscription is active, the handler SHALL attempt to roll up the current billing period's token usage from ClickHouse via sumTokenUsage. If ClickHouse is unavailable, the period usage is null and the fetch continues (degraded mode).

#### Scenario: ClickHouse fetch succeeds with active subscription
- **WHEN** subscription exists and is active, sumTokenUsage(orgId, periodStart, periodEnd) succeeds
- **THEN** extract inputTokens, outputTokens, cachedTokens, costMicros, executions from rollup and return as periodUsage

#### Scenario: ClickHouse fetch fails or times out
- **WHEN** sumTokenUsage throws an error
- **THEN** log warning "ClickHouse sumTokenUsage failed — periodUsage will be null", return periodUsage as null, do not propagate error

#### Scenario: no subscription exists
- **WHEN** subscription is null (org has no active subscription)
- **THEN** set periodUsage to null (do not attempt ClickHouse fetch)

---

### Requirement: create Stripe Checkout session for subscription upgrade
<!-- id: billingSubscriptionUpgradeStartHandler.handler -->
<!-- entities: Organization, Stripe -->
<!-- depends_on: reject billing action without authenticated principal, reject billing action without org scope -->
<!-- enforced: billing.subscription.upgrade.start.ts:22-29 -->
<!-- test: billing.subscription.upgrade.start.test.ts -->

When an authenticated caller scoped to an org requests a subscription upgrade, the handler SHALL call createCheckoutSession with the plan slug, billing interval, and redirect URLs, returning a Stripe Checkout URL.

#### Scenario: successful subscription upgrade checkout session creation
- **WHEN** ctx has valid userId/apiKeyId and orgId, input has planSlug, interval (month or year), successUrl, cancelUrl
- **THEN** call createCheckoutSession(orgId, planSlug, interval, successUrl, cancelUrl), return { checkoutUrl: url, planSlug, interval }

#### Scenario: checkout session creation fails
- **WHEN** createCheckoutSession throws any error
- **THEN** log error and re-throw the exception

---

### Requirement: emit audit event on successful subscription upgrade checkout
<!-- id: emitSecurityEvent.call -->
<!-- entities: Organization, User -->
<!-- depends_on: create Stripe Checkout session for subscription upgrade -->
<!-- enforced: billing.subscription.upgrade.start.ts:30-41 -->
<!-- test: billing.subscription.upgrade.start.test.ts -->

After successfully creating a Stripe Checkout session for a subscription upgrade, the handler SHALL emit a billing.checkout_initiated security event (fire-and-forget).

#### Scenario: audit event emitted after successful checkout
- **WHEN** createCheckoutSession returns successfully
- **THEN** call emitSecurityEvent with eventType: "billing.checkout_initiated", actorUserId, orgId, workspaceId, capability: "billing.subscription.upgrade.start", outcome: "success"

---

### Requirement: reject API key creation without authenticated principal
<!-- id: apiKeyCreateHandler.handler -->
<!-- entities: User, Organization, APIKey -->
<!-- enforced: api.key.create.ts:28-35 -->
<!-- test: api.key.create.test.ts -->

An api.key.create request SHALL be rejected if the caller has neither a userId nor an apiKeyId. The request MUST fail with a CapabilityError.authz_denied.

#### Scenario: API key creation without authenticated principal
- **WHEN** ctx.userId is null AND ctx.apiKeyId is null during api.key.create
- **THEN** throw CapabilityError("api.key.create", "authz_denied", "Unauthorized: no authenticated principal")

---

### Requirement: reject API key creation without org scope
<!-- id: apiKeyCreateHandler.handler -->
<!-- entities: Organization -->
<!-- enforced: api.key.create.ts:32-35 -->
<!-- test: api.key.create.test.ts -->

An api.key.create request SHALL be rejected if ctx.orgId is missing. API keys are org-scoped.

#### Scenario: API key creation without orgId
- **WHEN** ctx.orgId is null or empty, regardless of authentication
- **THEN** throw CapabilityError("api.key.create", "authz_denied", "Forbidden: orgId is required")

---

### Requirement: enforce org Owner/Admin role for API key management
<!-- id: resolveActorOrgRole.function -->
<!-- entities: Organization, Principal, Role, User -->
<!-- enforced: api.key.create.ts:41-48 -->
<!-- test: api.key.create.test.ts -->

Only users holding the org-scoped Owner or Admin role may create, revoke, or rotate API keys. The role is resolved by checking the principal row (parentUserId + orgId, status = "active"), then joining to the principal_role_assignments table to fetch the role name.

#### Scenario: actor holds Owner role
- **WHEN** resolveActorRole(orgId, userId) finds a principal with status "active" and a principal_role_assignment where role.name = "Owner" and scope_kind = "org"
- **THEN** grant authorization to proceed with api.key.create / api.key.revoke / api.key.rotate

#### Scenario: actor holds Admin role
- **WHEN** resolveActorRole(orgId, userId) finds principal with active status and role.name = "Admin" with org scope
- **THEN** grant authorization to proceed

#### Scenario: actor holds Member role
- **WHEN** resolveActorRole(orgId, userId) returns a role name not in [Owner, Admin], e.g., "Member"
- **THEN** throw CapabilityError("api.key.create", "authz_denied", "Forbidden: only org Owners and Admins can create API keys")

#### Scenario: no principal row exists
- **WHEN** resolveActorRole(orgId, userId) finds no principal row matching orgId + userId + status=active
- **THEN** return null, caller rejects with authz_denied error

---

### Requirement: reject API key creation without workspace scope
<!-- id: apiKeyCreateHandler.handler -->
<!-- entities: Workspace -->
<!-- enforced: api.key.create.ts:59-61 -->
<!-- test: api.key.create.test.ts -->

An api.key.create request SHALL be rejected if ctx.workspaceId is missing. API keys are tied to a specific workspace (via the orgScopeMixin).

#### Scenario: API key creation without workspaceId
- **WHEN** ctx.workspaceId is null or empty, after all authz checks pass
- **THEN** throw CapabilityError("api.key.create", "authz_denied", "Forbidden: workspaceId is required to create an API key")

---

### Requirement: generate cryptographically secure API key material
<!-- id: generateApiKey.function -->
<!-- entities: APIKey -->
<!-- enforced: api.key.create.ts:51, lib/api-key-authz.ts:59-64 -->

The API key generation routine SHALL produce a raw key in the format "ox_" + base64url(32 random bytes), extract a 12-character prefix, and compute the SHA-256 hash of the raw key (stored in hex). The raw key is ephemeral and never persisted.

#### Scenario: key generation produces three components
- **WHEN** generateApiKey() is called
- **THEN** generate 32 cryptographically random bytes, format as rawKey = "ox_" + base64url(bytes), extract keyPrefix = first 12 chars of rawKey, compute keyHash = SHA-256(rawKey) as hex, return { rawKey, keyPrefix, keyHash }

---

### Requirement: store API key row with role and workspace
<!-- id: apiKeyCreateHandler.handler -->
<!-- entities: Organization, Workspace, APIKey, User -->
<!-- depends_on: generate cryptographically secure API key material, enforce org Owner/Admin role for API key management, reject API key creation without workspace scope -->
<!-- enforced: api.key.create.ts:63-85 -->
<!-- test: api.key.create.test.ts -->

After authorization and key generation, the handler SHALL insert an api_keys row containing the orgId, workspaceId, keyPrefix, keyHash, name, scope, optional expiresAt, and audit fields (createdByUserId, updatedByUserId). The insert is atomic and returns the new row.

#### Scenario: successful API key row insertion
- **WHEN** all authz checks pass and key material is generated
- **THEN** insert into api_keys { orgId, workspaceId, keyPrefix, keyHash, name, scope, expiresAt (if present), createdByUserId: userId, updatedByUserId: userId }, return inserted row with id, publicId, name, keyPrefix, expiresAt, createdAt

#### Scenario: insert fails (internal error)
- **WHEN** insert returns empty result
- **THEN** throw Error("Internal error: failed to create API key row")

---

### Requirement: emit audit event on API key creation
<!-- id: emitSecurityEvent.call -->
<!-- entities: Organization, User, APIKey -->
<!-- depends_on: store API key row with role and workspace -->
<!-- enforced: api.key.create.ts:92-102 -->
<!-- test: api.key.create.test.ts -->

After successfully inserting an API key row, the handler SHALL emit an api_key.created security event (fire-and-forget) with the acting principal, org, and request metadata.

#### Scenario: audit event emitted after successful key creation
- **WHEN** insert completes successfully
- **THEN** call emitSecurityEvent with eventType: "api_key.created", actorUserId: userId, orgId, capability: "api.key.create", outcome: "success"

---

### Requirement: return raw API key once on creation
<!-- id: apiKeyCreateHandler.handler -->
<!-- entities: APIKey -->
<!-- depends_on: emit audit event on API key creation -->
<!-- enforced: api.key.create.ts:114-142 -->
<!-- test: api.key.create.test.ts -->

The raw API key SHALL be returned exactly once to the caller at creation time. For agent/app surfaces, a render directive MAY be included to display the key in the UI. For other surfaces, no render directive is returned.

#### Scenario: return raw key and metadata for API surface
- **WHEN** ctx.surface !== "app"
- **THEN** return { keyId, publicId, name, keyPrefix, rawKey, expiresAt, createdAt }

#### Scenario: return raw key with render directive for app surface
- **WHEN** ctx.surface === "app"
- **THEN** return { keyId, publicId, name, keyPrefix, rawKey, expiresAt, createdAt, render: { componentId: "api-key-display", props: { keyId, publicId, name, rawKey, createdAt, expiresAt } } }

---

### Requirement: reject API key revocation without authenticated principal
<!-- id: apiKeyRevokeHandler.handler -->
<!-- entities: User, Organization, APIKey -->
<!-- enforced: api.key.revoke.ts:25-28 -->
<!-- test: api.key.revoke.test.ts -->

An api.key.revoke request SHALL be rejected if the caller has neither a userId nor an apiKeyId.

#### Scenario: API key revocation without authenticated principal
- **WHEN** ctx.userId is null AND ctx.apiKeyId is null during api.key.revoke
- **THEN** throw CapabilityError("api.key.revoke", "authz_denied", "Unauthorized: no authenticated principal")

---

### Requirement: reject API key revocation without org scope
<!-- id: apiKeyRevokeHandler.handler -->
<!-- entities: Organization -->
<!-- enforced: api.key.revoke.ts:29-32 -->
<!-- test: api.key.revoke.test.ts -->

An api.key.revoke request SHALL be rejected if ctx.orgId is missing.

#### Scenario: API key revocation without orgId
- **WHEN** ctx.orgId is null or empty
- **THEN** throw CapabilityError("api.key.revoke", "authz_denied", "Forbidden: orgId is required")

---

### Requirement: soft-delete API key with org isolation
<!-- id: apiKeyRevokeHandler.handler -->
<!-- entities: Organization, APIKey, User -->
<!-- depends_on: enforce org Owner/Admin role for API key management -->
<!-- enforced: api.key.revoke.ts:49-80 -->
<!-- test: api.key.revoke.test.ts -->

When an authorized org Owner/Admin revokes an API key, the handler SHALL soft-delete the key by setting deletedAt and deletedByUserId. The key must exist, belong to the calling org, and not already be deleted (IDOR-safe query).

#### Scenario: revoke an active API key
- **WHEN** ctx has valid authz, input.keyPublicId matches an api_keys row with orgId=ctx.orgId and deletedAt is null
- **THEN** set deletedAt=now(), deletedByUserId=userId, updatedAt=now(), updatedByUserId=userId on the matching row

#### Scenario: key does not exist or already revoked
- **WHEN** no api_keys row matches publicId + orgId + isNull(deletedAt)
- **THEN** throw Error("Not found: API key does not exist, is not in this org, or is already revoked")

---

### Requirement: emit audit event on API key revocation
<!-- id: emitSecurityEvent.call -->
<!-- entities: Organization, User, APIKey -->
<!-- depends_on: soft-delete API key with org isolation -->
<!-- enforced: api.key.revoke.ts:83-93 -->
<!-- test: api.key.revoke.test.ts -->

After successfully soft-deleting an API key, the handler SHALL emit an api_key.revoked security event.

#### Scenario: audit event emitted after successful revocation
- **WHEN** soft-delete completes successfully
- **THEN** call emitSecurityEvent with eventType: "api_key.revoked", actorUserId: userId, orgId, capability: "api.key.revoke", outcome: "success"

---

### Requirement: reject API key rotation without authenticated principal
<!-- id: apiKeyRotateHandler.handler -->
<!-- entities: User, Organization, APIKey -->
<!-- enforced: api.key.rotate.ts:24-26 -->
<!-- test: api.key.rotate.test.ts -->

An api.key.rotate request SHALL be rejected if the caller has neither a userId nor an apiKeyId.

#### Scenario: API key rotation without authenticated principal
- **WHEN** ctx.userId is null AND ctx.apiKeyId is null during api.key.rotate
- **THEN** throw CapabilityError("api.key.rotate", "authz_denied", "Unauthorized: no authenticated principal")

---

### Requirement: reject API key rotation without org scope
<!-- id: apiKeyRotateHandler.handler -->
<!-- entities: Organization -->
<!-- enforced: api.key.rotate.ts:27-29 -->
<!-- test: api.key.rotate.test.ts -->

An api.key.rotate request SHALL be rejected if ctx.orgId is missing.

#### Scenario: API key rotation without orgId
- **WHEN** ctx.orgId is null or empty
- **THEN** throw CapabilityError("api.key.rotate", "authz_denied", "Forbidden: orgId is required")

---

### Requirement: atomically rotate API key in single transaction
<!-- id: apiKeyRotateHandler.handler -->
<!-- entities: Organization, APIKey, Workspace, User -->
<!-- depends_on: enforce org Owner/Admin role for API key management, generate cryptographically secure API key material -->
<!-- enforced: api.key.rotate.ts:43-106 -->
<!-- test: api.key.rotate.test.ts -->

When an authorized org Owner/Admin rotates an API key, the handler SHALL atomically (in one transaction): load the old key (IDOR-safe), insert a new key inheriting the old key's scope/workspace/expiresAt, and soft-delete the old key. The new raw key is returned exactly once.

#### Scenario: successful atomic rotation
- **WHEN** ctx has valid authz, input.keyPublicId matches an active api_keys row in orgId=ctx.orgId
- **THEN** within a single transaction: 1) select old key by publicId + orgId + isNull(deletedAt), 2) insert new key with same scope, workspaceId, expiresAt; name=input.name or old name, 3) set old key deletedAt=now(), deletedByUserId=userId, return { inserted new key, revokedPublicId: old key publicId }

#### Scenario: old key not found or already revoked
- **WHEN** no api_keys row matches publicId + orgId + isNull(deletedAt)
- **THEN** throw Error("Not found: API key does not exist, is not in this org, or is already revoked")

#### Scenario: new key insertion fails
- **WHEN** insert of replacement key returns empty result
- **THEN** throw Error("Internal error: failed to create replacement API key row"), do not commit transaction

---

### Requirement: emit audit events on API key rotation
<!-- id: emitSecurityEvent.call -->
<!-- entities: Organization, User, APIKey -->
<!-- depends_on: atomically rotate API key in single transaction -->
<!-- enforced: api.key.rotate.ts:108-130 -->
<!-- test: api.key.rotate.test.ts -->

After successfully rotating an API key, the handler SHALL emit two security events: api_key.created (for the new key) and api_key.revoked (for the old key), both fire-and-forget.

#### Scenario: both audit events emitted after successful rotation
- **WHEN** atomic rotation completes successfully
- **THEN** emit emitSecurityEvent with eventType: "api_key.created", outcome: "success", capability: "api.key.rotate", AND emit emitSecurityEvent with eventType: "api_key.revoked", outcome: "success", capability: "api.key.rotate"

---

### Requirement: return new API key material and revoked key metadata on rotation
<!-- id: apiKeyRotateHandler.handler -->
<!-- entities: APIKey -->
<!-- depends_on: emit audit events on API key rotation -->
<!-- enforced: api.key.rotate.ts:143-154 -->
<!-- test: api.key.rotate.test.ts -->

The rotation response SHALL include the new key's full details (keyId, publicId, name, keyPrefix, rawKey, expiresAt, createdAt) and metadata about the revoked old key (revokedKeyPublicId, revokedAt).

#### Scenario: rotation response includes new and revoked key details
- **WHEN** atomic rotation and audit emission complete
- **THEN** return { keyId, publicId, name, keyPrefix, rawKey, expiresAt, createdAt, revokedKeyPublicId, revokedAt }

---

### Invariant: API key prefix is always 12 characters
<!-- entities: APIKey -->
<!-- enforced: lib/api-key-authz.ts:60-61 -->

The API key prefix stored in the api_keys table SHALL always be exactly 12 characters, extracted from the raw key. This prefix enables fast index lookups during request authentication.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: raw API key is never stored in any database
<!-- entities: APIKey -->
<!-- enforced: api.key.create.ts:51, api.key.rotate.ts:40, lib/api-key-authz.ts:59-64 -->

The raw API key material (the secret that callers use for authentication) SHALL never be persisted to any database. Only the SHA-256 hash and 12-character prefix are stored; the raw key is computed once during generation and returned exactly once to the caller.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: soft-deleted API key remains invalid permanently
<!-- entities: APIKey -->
<!-- enforced: api.key.revoke.ts:49-79, api.key.rotate.ts:95-103 -->

Once an API key is soft-deleted (deletedAt is set), it SHALL remain invalid for all subsequent authentication requests. The key row is retained for audit purposes, but resolveApiKey filters on isNull(deletedAt) and will never validate a soft-deleted key.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: subscription is only active in defined states
<!-- entities: Subscription -->
<!-- enforced: billing.subscription.read.ts:9, 44 -->

A subscription SHALL be considered active and included in billing.subscription.read results only when its status is in [trialing, active, past_due, paused]. Any other status (e.g., canceled, draft) SHALL exclude the subscription from results.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: credit balance is always a non-negative integer in cents
<!-- entities: CreditBalance -->
<!-- enforced: billing.subscription.read.ts:64, 124 -->

The creditBalanceCents returned by billing.subscription.read SHALL always be a non-negative integer representing the org's usable credit balance. If no balance row exists, the balance defaults to 0.

> Last verified: 2026-06-20 (commit 2f628504)
