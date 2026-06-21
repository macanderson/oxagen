# Spec: app-lib-domain

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: audit-export.ts, audit-filters.ts, audit-query.ts, billing-format.ts, compliance-controls.ts, enterprise.ts, linked-provider.ts, oauth-prefill.ts, plan-label.ts, plugin-icon.ts, seat-alert.ts
> Last verified: 2026-06-20 (commit 2f628504)

## Description

Pure domain-logic helpers in `apps/app/src/lib/` for audit-log export/filtering/querying, billing/plan formatting, compliance control derivation, enterprise tier gating, OAuth profile prefill, and seat-limit alerts. No framework dependencies; node-testable. All behaviors are deterministic computations over domain entities (AuditEventRow, ControlSignals, OrgSeatUsage, user profile) with no side effects beyond return values.

---

### Requirement: Audit export serialization to RFC-4180 CSV format
<!-- id: audit-export.toCSV -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-export.ts:toCSV() -->
<!-- test: implicit (unit-tested via route handler) -->

CSV rows SHALL be serialized in stable column order with RFC-4180 field quoting (double-quoted when value contains comma, quote, or newline; internal quotes escaped as double-double). Header line lists all column names in order.

#### Scenario: CSV with safe fields
- **WHEN** toCSV receives rows with non-special characters
- **THEN** each row is comma-joined field values with no quoting

#### Scenario: CSV escapes special characters
- **WHEN** a field contains comma, quote, or newline
- **THEN** field is double-quoted and internal quotes are doubled

#### Scenario: CSV terminates with CRLF
- **WHEN** toCSV completes
- **THEN** output ends with `\r\n`

---

### Requirement: Audit export serialization to newline-delimited JSON
<!-- id: audit-export.toNDJSON -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-export.ts:toNDJSON() -->

NDJSON output SHALL be one JSON object per line (no leading/trailing empty lines except final newline when rows exist).

#### Scenario: NDJSON with no rows
- **WHEN** rows is empty array
- **THEN** output is empty string

#### Scenario: NDJSON with rows
- **WHEN** rows is non-empty
- **THEN** each row becomes one JSON line, output ends with `\n`

---

### Requirement: Route-agnostic audit export serialization dispatch
<!-- id: audit-export.serializeAuditExport -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-export.ts:serializeAuditExport() -->
<!-- test: implicit (called by route handler) -->

Format parameter ("csv" or "ndjson") SHALL determine which serializer runs. Both produce the same field/row data.

#### Scenario: CSV serialization
- **WHEN** format is "csv"
- **THEN** toCSV result is returned

#### Scenario: NDJSON serialization
- **WHEN** format is "ndjson"
- **THEN** toNDJSON result is returned

---

### Requirement: HMAC-SHA256 signing of audit export body
<!-- id: audit-export.signAuditExport -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-export.ts:signAuditExport() -->

Export body (CSV or NDJSON string) SHALL be signed with HMAC-SHA256 under a shared secret, returning hex-encoded digest.

#### Scenario: Signature generation
- **WHEN** signAuditExport receives body and secret
- **THEN** returns hex-encoded HMAC-SHA256(secret, body)

---

### Requirement: Timing-safe audit export signature verification
<!-- id: audit-export.verifyAuditExport -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-export.ts:verifyAuditExport() -->

Signature verification SHALL use constant-time comparison to prevent timing attacks. Digest length mismatch always fails.

#### Scenario: Valid signature
- **WHEN** signature matches expected HMAC
- **THEN** returns true

#### Scenario: Invalid signature
- **WHEN** signature does not match
- **THEN** returns false

#### Scenario: Length mismatch
- **WHEN** signature length != expected digest length
- **THEN** returns false immediately

---

### Requirement: Audit export content-type header selection
<!-- id: audit-export.exportContentType -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-export.ts:exportContentType() -->

Content-Type header SHALL match export format (CSV → text/csv; NDJSON → application/x-ndjson), both UTF-8.

#### Scenario: CSV content-type
- **WHEN** format is "csv"
- **THEN** returns "text/csv; charset=utf-8"

#### Scenario: NDJSON content-type
- **WHEN** format is "ndjson"
- **THEN** returns "application/x-ndjson; charset=utf-8"

---

### Requirement: Audit export filename generation
<!-- id: audit-export.exportFilename -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-export.ts:exportFilename() -->

Filename SHALL be `audit-export-<ISO-timestamp>.{csv|ndjson}` with colons/dots in timestamp escaped to dashes (safe for all filesystems).

#### Scenario: CSV filename
- **WHEN** isoStamp is "2026-06-20T14:30:45.000Z" and format is "csv"
- **THEN** returns "audit-export-2026-06-20T14-30-45-000Z.csv"

#### Scenario: NDJSON filename
- **WHEN** format is "ndjson"
- **THEN** returns filename ending in ".ndjson"

---

### Requirement: Audit filter parsing from Next.js search params
<!-- id: audit-filters.parseAuditFilter -->
<!-- entities: SecurityEventType, SecurityOutcome -->
<!-- enforced: audit-filters.ts:parseAuditFilter() -->
<!-- test: implicit (viewer page logic) -->

Raw searchParams (string | string[] | undefined) SHALL be parsed into typed AuditFilter. Unknown event types/outcomes are silently dropped (malformed URL degrades gracefully). Cursor format is keyset tuple `<ISO-timestamp>|<id>`.

#### Scenario: Empty search params
- **WHEN** sp is empty object
- **THEN** returns filter with all nulls/empty arrays

#### Scenario: Event type filtering
- **WHEN** sp contains event_type (repeated or comma-joined)
- **WHEN** only valid types are included
- **THEN** eventTypes is deduplicated set

#### Scenario: Unknown event types are silently dropped
- **WHEN** sp contains "event_type=user.login&event_type=invalid.type"
- **THEN** only valid "user.login" is included, "invalid.type" is skipped

#### Scenario: Outcome filtering
- **WHEN** sp contains valid outcome
- **THEN** outcome is set

#### Scenario: Invalid outcome is dropped
- **WHEN** sp contains "outcome=BOGUS"
- **THEN** outcome is null

#### Scenario: Actor user ID filtering
- **WHEN** sp contains "actor=<uuid>"
- **THEN** actorUserId is set

#### Scenario: Free-text search
- **WHEN** sp contains "q=search term"
- **THEN** q is trimmed and set

#### Scenario: Empty q is dropped
- **WHEN** sp contains "q=" or "q=   "
- **THEN** q is null

#### Scenario: Date range filtering
- **WHEN** sp contains "from" and "to" ISO strings
- **THEN** from/to are parsed to Date

#### Scenario: Invalid date strings are dropped
- **WHEN** sp contains "from=not-a-date"
- **THEN** from is null

#### Scenario: Keyset cursor parsing
- **WHEN** sp contains "cursor=<ISO-timestamp>|<id>"
- **THEN** cursor is { occurredAt, id }

#### Scenario: Malformed cursor is dropped
- **WHEN** sp contains "cursor=no-pipe" or "cursor=<invalid-date>|id"
- **THEN** cursor is null

---

### Requirement: Audit filter encoding to URL search params
<!-- id: audit-filters.encodeAuditFilter -->
<!-- entities: SecurityEventType, SecurityOutcome -->
<!-- enforced: audit-filters.ts:encodeAuditFilter() -->

Filter SHALL be round-trippable: encode → parse produces equivalent filter. Optional cursor override in opts replaces filter.cursor.

#### Scenario: Round-trip invariant
- **WHEN** filter is encoded and parsed
- **THEN** result equals original

#### Scenario: Event types are appended (multi-value)
- **WHEN** filter has multiple eventTypes
- **THEN** each is added as separate "event_type=X" param

#### Scenario: Cursor override
- **WHEN** opts.cursor is provided
- **THEN** uses opts.cursor instead of filter.cursor

#### Scenario: Null fields are omitted
- **WHEN** filter.outcome is null
- **THEN** outcome param is not set

---

### Requirement: Cursor construction from audit event row
<!-- id: audit-filters.cursorOf -->
<!-- entities: AuditEventRow -->
<!-- enforced: audit-filters.ts:cursorOf() -->

Extracts occurredAt and id from a row into a keyset cursor tuple.

#### Scenario: Cursor from row
- **WHEN** cursorOf receives { occurredAt, id, ...other }
- **THEN** returns { occurredAt, id }

---

### Requirement: Detect active audit filter
<!-- id: audit-filters.hasActiveFilter -->
<!-- entities: SecurityEventType, SecurityOutcome -->
<!-- enforced: audit-filters.ts:hasActiveFilter() -->

Returns true when any user-facing filter is set (used to show "clear" affordance).

#### Scenario: No filters active
- **WHEN** all arrays/dates/strings are empty/null
- **THEN** returns false

#### Scenario: Event type filter active
- **WHEN** eventTypes.length > 0
- **THEN** returns true

#### Scenario: Date range active
- **WHEN** from or to is set
- **THEN** returns true

---

### Requirement: Event type grouping by prefix
<!-- id: audit-filters.eventTypesInGroup -->
<!-- entities: SecurityEventType -->
<!-- enforced: audit-filters.ts:eventTypesInGroup() -->

Returns all event types matching a group prefix (e.g., "auth" → "auth.*").

#### Scenario: Group expansion
- **WHEN** eventTypesInGroup("user")
- **THEN** returns all SECURITY_EVENT_TYPES starting with "user."

---

### Requirement: Query one page of audit events with keyset pagination
<!-- id: audit-query.queryAuditPage -->
<!-- entities: AuditEventRow, Org -->
<!-- enforced: audit-query.ts:queryAuditPage() -->
<!-- test: implicit (viewer page) -->

Fetches at most pageSize rows, over-fetches by 1 to detect whether next page exists. Rows ordered DESC by (occurred_at, id). Errors are logged and return empty page gracefully.

#### Scenario: First page
- **WHEN** filter.cursor is null
- **THEN** returns up to pageSize most recent rows

#### Scenario: Subsequent page via cursor
- **WHEN** filter.cursor is set
- **THEN** returns rows strictly "older" than cursor (keyset: occurred_at < cursor.occurred_at, or both equal and id < cursor.id)

#### Scenario: Page exhaustion
- **WHEN** fewer than pageSize rows remain
- **THEN** nextCursor is null

#### Scenario: More rows exist
- **WHEN** over-fetched row exists
- **THEN** nextCursor is set to last row of page, hasMore indicator returns true via page length

#### Scenario: Filter conditions apply
- **WHEN** filter.eventTypes, outcome, actorUserId, q, from, to are set
- **THEN** WHERE clause includes all conditions (orgId always required)

#### Scenario: Free-text search matches capability, ip, request_id, user_agent
- **WHEN** filter.q is set
- **THEN** OR clause matches ILIKE on those four columns

#### Scenario: Date range is inclusive
- **WHEN** filter.from and filter.to are set
- **THEN** occurred_at >= from AND occurred_at <= to

#### Scenario: Query error returns empty page
- **WHEN** DB query throws
- **THEN** error is logged, { rows: [], nextCursor: null } is returned

---

### Requirement: Bulk-fetch audit events for export with memory-bounded pagination
<!-- id: audit-query.queryAuditForExport -->
<!-- entities: AuditEventRow, Org -->
<!-- enforced: audit-query.ts:queryAuditForExport() -->

Walks keyset pages up to maxRows without loading all results into memory. Stops early if next page does not exist.

#### Scenario: Export under limit
- **WHEN** total matching rows < maxRows
- **THEN** all rows are fetched

#### Scenario: Export truncated at limit
- **WHEN** total rows >= maxRows
- **THEN** exactly maxRows rows are fetched and returned

#### Scenario: Efficient page-walking
- **WHEN** remaining rows > AUDIT_PAGE_SIZE
- **THEN** full pages are fetched and accumulated

#### Scenario: Last partial page
- **WHEN** remaining rows <= AUDIT_PAGE_SIZE and nextCursor is null
- **THEN** loop exits without trying to fetch next page

---

### Requirement: Format relative renewal date with human-readable time units
<!-- id: billing-format.formatRelativeRenewal -->
<!-- entities: Subscription -->
<!-- enforced: billing-format.ts:formatRelativeRenewal() -->
<!-- test: billing-format.test.ts:formatRelativeRenewal -->

Compares end date to "now" (UTC whole-days). Returns phrases like "renews today", "renews in 3 days on June 8th", "renews in 1 month on July 5th". When cancel=true, "renews" is replaced with "cancels".

#### Scenario: Same day as now (≤0 days)
- **WHEN** end equals or is before now
- **THEN** returns "[renews/cancels] today"

#### Scenario: Exactly 1 day ahead
- **WHEN** end is tomorrow
- **THEN** returns "[renews/cancels] tomorrow on June 6th, 2026"

#### Scenario: 2 to 30 days
- **WHEN** end is 2–30 days away
- **THEN** returns "[renews/cancels] in N days on <ordinal-date>"

#### Scenario: Beyond 30 days switches to months
- **WHEN** end is 31+ days away
- **THEN** returns "[renews/cancels] in M months on <ordinal-date>" (months = round(days/30))

#### Scenario: Ordinal date formatting
- **WHEN** formatting day 1, 11, 21, 22, 23
- **THEN** returns "1st", "11th", "21st", "22nd", "23rd"

#### Scenario: cancel option replaces verb
- **WHEN** cancel=true
- **THEN** "renews" becomes "cancels"

#### Scenario: Input accepts Date or ISO string
- **WHEN** end is Date object or ISO string
- **THEN** both are parsed correctly

---

### Requirement: Derive SOC 2 compliance control status from signals
<!-- id: compliance-controls.deriveComplianceControls -->
<!-- entities: Org, SecurityPolicy -->
<!-- enforced: compliance-controls.ts:deriveComplianceControls() -->
<!-- test: compliance-controls.test.ts:deriveComplianceControls -->

Pure derivation of 6 SOC 2 controls (CC6.1, CC6.2, CC6.3, CC6.api, CC7.2, CC9.2) from signal inputs. No DB dependency.

#### Scenario: CC6.1 (logical access) not_started
- **WHEN** rlsEnforced=false AND mfaRequired=false
- **THEN** status="not_started"

#### Scenario: CC6.1 (logical access) partial
- **WHEN** rlsEnforced=true AND mfaRequired=false
- **THEN** status="partial"

#### Scenario: CC6.1 (logical access) active
- **WHEN** rlsEnforced=true AND mfaRequired=true
- **THEN** status="active"

#### Scenario: CC6.2 (auth & credential) partial
- **WHEN** mfaRequired=false
- **THEN** status="partial"

#### Scenario: CC6.2 (auth & credential) active
- **WHEN** mfaRequired=true
- **THEN** status="active"

#### Scenario: CC6.3 (role-based access) always partial
- **WHEN** any signal values
- **THEN** status="partial" (no automated quarterly reviews yet)

#### Scenario: CC7.2 (audit trail) partial
- **WHEN** auditEventCount=0
- **THEN** status="partial", rationale includes "no events recorded"

#### Scenario: CC7.2 (audit trail) active
- **WHEN** auditEventCount > 0
- **THEN** status="active", rationale includes event count formatted with thousands separator

#### Scenario: CC9.2 (vendor risk) always partial
- **WHEN** any signal values
- **THEN** status="partial" (formal assessments in progress)

#### Scenario: CC6.api (key rotation) active
- **WHEN** oldestActiveApiKeyDays=null (no active keys)
- **THEN** status="active"

#### Scenario: CC6.api (key rotation) active within 180 days
- **WHEN** oldestActiveApiKeyDays <= 180
- **THEN** status="active"

#### Scenario: CC6.api (key rotation) partial when stale
- **WHEN** oldestActiveApiKeyDays > 180
- **THEN** status="partial", rationale includes day count

---

### Requirement: Summarize compliance controls into counts
<!-- id: compliance-controls.summariseControls -->
<!-- entities: ComplianceControl -->
<!-- enforced: compliance-controls.ts:summariseControls() -->
<!-- test: compliance-controls.test.ts:summariseControls -->

Returns object with total, active, partial, notStarted counts.

#### Scenario: Count totals
- **WHEN** summariseControls receives control array
- **THEN** active + partial + notStarted = total

#### Scenario: Status filtering
- **WHEN** controls have mixed status
- **THEN** each status is counted correctly

---

### Requirement: Resolve org tier and check Enterprise compliance access
<!-- id: enterprise.getEnterpriseAccess -->
<!-- entities: Org, Subscription -->
<!-- enforced: enterprise.ts:getEnterpriseAccess() -->

Pure read that resolves an org's subscription tier and whether it meets Enterprise minimum. Called once per page to thread isEnterprise into UI.

#### Scenario: Enterprise-tier org
- **WHEN** org has active subscription with tier="enterprise"
- **THEN** returns { tier: "enterprise", isEnterprise: true }

#### Scenario: Below-Enterprise tier
- **WHEN** org has tier="build"
- **THEN** returns { tier: "build", isEnterprise: false }

---

### Requirement: Assert Enterprise tier in server actions and route handlers
<!-- id: enterprise.assertEnterprise -->
<!-- entities: Org, Subscription -->
<!-- enforced: enterprise.ts:assertEnterprise() -->

Hard gate that throws TierDeniedError when org is below Enterprise. Prevents button-bypass attacks on compliance features.

#### Scenario: Enterprise org passes
- **WHEN** org tier is "enterprise"
- **THEN** no error; function returns

#### Scenario: Non-Enterprise org throws
- **WHEN** org tier is "build"
- **THEN** TierDeniedError is thrown with feature name in message

---

### Requirement: Resolve user's linked OAuth provider
<!-- id: linked-provider.getLinkedSocialProvider -->
<!-- entities: User, Account -->
<!-- enforced: linked-provider.ts:getLinkedSocialProvider() -->

Returns the preferred linked OAuth provider (Google > GitHub > null). Used to attribute profile prefill on new-organization form. Reads global auth.accounts table (no RLS).

#### Scenario: Google linked
- **WHEN** user has account with providerId="google"
- **THEN** returns "google"

#### Scenario: GitHub linked but not Google
- **WHEN** user has account with providerId="github" but not google
- **THEN** returns "github"

#### Scenario: Multiple accounts, prefer Google
- **WHEN** user has both google and github linked
- **THEN** returns "google"

#### Scenario: Only credential provider
- **WHEN** user has no OAuth accounts (only credential)
- **THEN** returns null

---

### Requirement: Extract email domain
<!-- id: oauth-prefill.emailDomain -->
<!-- entities: User -->
<!-- enforced: oauth-prefill.ts:emailDomain() -->
<!-- test: oauth-prefill.test.ts:emailDomain -->

Extracts and lower-cases domain part of email. Returns null for malformed addresses, missing @, or no dot in domain.

#### Scenario: Valid email domain
- **WHEN** email is "jane@acme.com"
- **THEN** returns "acme.com" (lower-cased)

#### Scenario: Case normalization
- **WHEN** email is "jane@ACME.COM"
- **THEN** returns "acme.com"

#### Scenario: Last @ for quirky local parts
- **WHEN** email is "a@b@acme.io"
- **THEN** returns "acme.io"

#### Scenario: No @ symbol
- **WHEN** email is "not-an-email"
- **THEN** returns null

#### Scenario: No dot in domain
- **WHEN** email is "user@localhost"
- **THEN** returns null

#### Scenario: Null or empty email
- **WHEN** email is null, undefined, or ""
- **THEN** returns null

---

### Requirement: Identify consumer email domains
<!-- id: oauth-prefill.isConsumerEmailDomain -->
<!-- entities: User -->
<!-- enforced: oauth-prefill.ts:isConsumerEmailDomain() -->
<!-- test: oauth-prefill.test.ts:isConsumerEmailDomain -->

Returns true for well-known consumer providers (Gmail, iCloud, Proton, etc.). Treats null/empty as consumer (safe default). Business domains return false.

#### Scenario: Well-known consumer provider
- **WHEN** domain is "gmail.com", "icloud.com", or "proton.me"
- **THEN** returns true

#### Scenario: Business domain
- **WHEN** domain is "acme.com" or "oxagen.ai"
- **THEN** returns false

#### Scenario: Null or empty is consumer
- **WHEN** domain is null or ""
- **THEN** returns true

#### Scenario: Case-insensitive match
- **WHEN** domain is "GMAIL.COM"
- **THEN** returns true

---

### Requirement: Derive company name from email domain
<!-- id: oauth-prefill.companyNameFromDomain -->
<!-- entities: User -->
<!-- enforced: oauth-prefill.ts:companyNameFromDomain() -->
<!-- test: oauth-prefill.test.ts:companyNameFromDomain -->

Title-cases the registrable label (second-to-last domain component). Ignores "www" prefix. Splits hyphens/underscores into words. Returns "" for unusable input.

#### Scenario: Simple domain
- **WHEN** domain is "acme.com"
- **THEN** returns "Acme"

#### Scenario: Hyphenated domain
- **WHEN** domain is "acme-corp.io"
- **THEN** returns "Acme Corp"

#### Scenario: Underscore-separated domain
- **WHEN** domain is "big_data.ai"
- **THEN** returns "Big Data"

#### Scenario: Ignore www subdomain
- **WHEN** domain is "www.acme.com"
- **THEN** returns "Acme" (not "Www")

#### Scenario: Ignore common subdomain prefixes
- **WHEN** domain is "mail.acme.com"
- **THEN** returns "Acme"

#### Scenario: Invalid input
- **WHEN** domain is null, "", or "localhost"
- **THEN** returns ""

---

### Requirement: Build new-organization form prefill from user profile
<!-- id: oauth-prefill.buildOrgSignupPrefill -->
<!-- entities: User -->
<!-- enforced: oauth-prefill.ts:buildOrgSignupPrefill() -->
<!-- test: oauth-prefill.test.ts:buildOrgSignupPrefill -->

Derives form defaults from OAuth profile (name, email, avatar, provider). Business domain seeding is only performed for non-consumer email domains. All fields are trimmed.

#### Scenario: Business domain prefill
- **WHEN** email is "jane@acme-corp.io" (non-consumer)
- **THEN** suggestedBusinessName="Acme Corp", suggestedWebsite="https://acme-corp.io"

#### Scenario: Consumer domain no business seeding
- **WHEN** email is "jane@gmail.com"
- **THEN** suggestedBusinessName="", suggestedWebsite=""

#### Scenario: Trim whitespace
- **WHEN** name is "  Bob  ", email is "  bob@acme.com  "
- **THEN** name="Bob", email="bob@acme.com"

#### Scenario: Missing fields default to empty/null
- **WHEN** profile is {}
- **THEN** all fields are "" or null

#### Scenario: Provider pass-through
- **WHEN** input.provider="google"
- **THEN** provider="google" in output

#### Scenario: Avatar URL pass-through
- **WHEN** input.image="https://lh3.googleusercontent.com/..."
- **THEN** avatarUrl is that URL (trimmed)

---

### Requirement: Resolve plan tier label from subscription and legacy columns
<!-- id: plan-label.planLabelFrom -->
<!-- entities: Org, Subscription -->
<!-- enforced: plan-label.ts:planLabelFrom() -->
<!-- test: plan-label.test.ts:planLabelFrom -->

Subscription tier is authoritative; falls back to legacy plan_type. Returns label string for display (never null).

#### Scenario: Subscription tier present
- **WHEN** subscriptionTier="scale"
- **THEN** returns TIER_LABELS["scale"] = "Scale"

#### Scenario: Subscription overrides legacy
- **WHEN** subscriptionTier="enterprise", legacyPlanType="build"
- **THEN** returns "Enterprise" (not "Build")

#### Scenario: Fall back to legacy
- **WHEN** subscriptionTier=null, legacyPlanType="build"
- **THEN** returns "Build"

#### Scenario: Both invalid defaults to Free
- **WHEN** subscriptionTier=null, legacyPlanType=null
- **THEN** returns "Free"

#### Scenario: Unknown value defaults to Free
- **WHEN** subscriptionTier="unknown"
- **THEN** returns "Free"

---

### Requirement: Get plan tier label
<!-- id: plan-label.planTierLabel -->
<!-- entities: Subscription -->
<!-- enforced: plan-label.ts:planTierLabel() -->
<!-- test: plan-label.test.ts:planTierLabel -->

Returns label for a tier string. Unknown/null/undefined → "Free". Valid tiers map to TIER_LABELS.

#### Scenario: Free tier
- **WHEN** tier="free"
- **THEN** returns "Free"

#### Scenario: Build tier
- **WHEN** tier="build"
- **THEN** returns "Build"

#### Scenario: Scale tier
- **WHEN** tier="scale"
- **THEN** returns "Scale"

#### Scenario: Enterprise tier
- **WHEN** tier="enterprise"
- **THEN** returns "Enterprise"

#### Scenario: Invalid tier
- **WHEN** tier="pro" or "unknown"
- **THEN** returns "Free"

#### Scenario: Null or undefined
- **WHEN** tier=null or undefined
- **THEN** returns "Free"

#### Scenario: Case-sensitive (lowercase only)
- **WHEN** tier="Build" (capitalized)
- **THEN** returns "Free" (not recognized)

---

### Requirement: Validate plugin icon URL for next/image
<!-- id: plugin-icon.isRenderableImageUrl -->
<!-- entities: PluginListing -->
<!-- enforced: plugin-icon.ts:isRenderableImageUrl() -->
<!-- test: plugin-icon.test.ts:isRenderableImageUrl -->

Returns true for absolute HTTP(S) URLs and root-relative paths. Rejects Lucide icon names (historical capability-pack regression), null, undefined, and empty strings. Enables safe next/image rendering with glyph fallback.

#### Scenario: Absolute HTTPS URL
- **WHEN** value="https://example.com/icon.png"
- **THEN** returns true

#### Scenario: Absolute HTTP URL
- **WHEN** value="http://example.com/icon.svg"
- **THEN** returns true

#### Scenario: Root-relative path
- **WHEN** value="/icons/plug.png"
- **THEN** returns true

#### Scenario: Lucide icon name (regression)
- **WHEN** value="image" or "shapes" or "file-text"
- **THEN** returns false

#### Scenario: Relative path
- **WHEN** value="./icon.png"
- **THEN** returns false

#### Scenario: Bare domain without protocol
- **WHEN** value="example.com/icon.png"
- **THEN** returns false

#### Scenario: Null or empty
- **WHEN** value=null, undefined, or ""
- **THEN** returns false

---

### Requirement: Derive seat-usage alert for org members surface
<!-- id: seat-alert.seatAlert -->
<!-- entities: Org, OrgMember, Subscription -->
<!-- enforced: seat-alert.ts:seatAlert() -->
<!-- test: implicit (members page) -->

Maps OrgSeatUsage (licenses, used, available) to a UI alert descriptor with variant, title, body, and optional CTA. Priority: over-provisioned error > at-limit warning > available success.

#### Scenario: Over-provisioned (used > licenses)
- **WHEN** used=5, licenses=3
- **THEN** variant="error", title="You have more members than licenses", CTA links to billing subscription

#### Scenario: At limit with single license (free plan)
- **WHEN** licenses=1, available=0
- **THEN** variant="warning", title="You have 1 user license", body mentions "Increase your licenses on Billing"

#### Scenario: At limit with multiple licenses
- **WHEN** licenses=5, used=5, available=0
- **THEN** variant="warning", title="All 5 licenses are in use", CTA links to billing

#### Scenario: Seats available (plural)
- **WHEN** available=3
- **THEN** variant="success", title="3 licenses available", body mentions "invite more teammates"

#### Scenario: Single seat available
- **WHEN** available=1
- **THEN** variant="success", title="1 license available", body mentions "invite a teammate" (singular)

#### Scenario: CTA href includes org slug
- **WHEN** seatAlert receives orgSlug="acme"
- **THEN** CTA href is "/{orgSlug}/billing/subscription"

---

<!-- deferred: none -->
<!-- uncertainty: linked-provider.ts and oauth-prefill.ts do not have unit tests, only their exported functions do. Behavior is inferred from call signatures and dependencies on @oxagen/database and @oxagen/billing. -->
