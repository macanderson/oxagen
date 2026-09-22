import {
  bigint,
  boolean,
  check,
  index,
  integer,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authSchema } from "./_schemas";
import {
  auditMixin,
  bytea,
  citext,
  idMixin,
  softDeleteMixin,
  orgScopeMixin,
} from "./_mixins";

// ── User-preference enums ────────────────────────────────────────────────────
// Declared in the auth schema so the type lives next to the table that owns it.
// Shared with workspace.workspaces for model-tier columns (imported from here).

/** UI text size preference. */
export const fontSizeEnum = authSchema.enum("font_size", [
  "small",
  "medium",
  "large",
]);

/** UI density / spacing preference. */
export const densityEnum = authSchema.enum("density", [
  "compact",
  "comfortable",
  "spacious",
]);

/**
 * What to do when the user submits a new prompt while the agent is responding.
 * queue = buffer it; interrupt = cancel the in-flight response immediately.
 */
export const pendingPromptBehaviorEnum = authSchema.enum(
  "pending_prompt_behavior",
  ["queue", "interrupt"],
);

/**
 * Oxagen model-tier alias. Maps to a quality/cost tier rather than a specific
 * model slug, letting us swap underlying models without user-facing changes.
 * fast = lowest-latency; balanced = default quality/cost; precise = best quality.
 */
export const modelTierEnum = authSchema.enum("model_tier", [
  "fast",
  "balanced",
  "precise",
]);

export const users = authSchema.table(
  "users",
  {
    ...idMixin("usr"),
    ...auditMixin(),
    ...softDeleteMixin(),
    email: citext("email").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    // Better Auth twoFactor plugin flag. Flipped to true only after the user
    // completes first TOTP verification (see twoFactorTable below). Enforcement
    // for privileged (owner/admin) roles reads this column. input:false on the
    // BA side — never set directly by the client.
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  }),
);

export const apiKeys = authSchema.table(
  "api_keys",
  {
    ...idMixin("aky"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    name: text("name").notNull(),
    scope: jsonb("scope").notNull(),
    // Server-owned proof that this key was issued by the Stella enrollment
    // workflow. Generic API-key create/rotate capabilities never accept or
    // populate these columns; nullable defaults make pre-rollout scope markers
    // fail closed until an operator enrollment explicitly binds the key.
    stellaTelemetryEnrollmentId: text("stella_telemetry_enrollment_id"),
    stellaTelemetryEnrolledAt: timestamp("stella_telemetry_enrolled_at", {
      withTimezone: true,
      mode: "date",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    keyPrefixIdx: uniqueIndex("api_keys_key_prefix_idx").on(t.keyPrefix),
    orgIdx: index("api_keys_org_idx").on(t.orgId, t.workspaceId),
    stellaTelemetryEnrollmentCheck: check(
      "api_keys_stella_telemetry_enrollment_check",
      sql`(${t.stellaTelemetryEnrollmentId} IS NULL AND ${t.stellaTelemetryEnrolledAt} IS NULL) OR (${t.stellaTelemetryEnrollmentId} IS NOT NULL AND ${t.stellaTelemetryEnrollmentId} ~ '^[A-Za-z0-9._:-]{1,128}$' AND ${t.stellaTelemetryEnrolledAt} IS NOT NULL)`,
    ),
  }),
);

// Better Auth tables — spec §15.4. Better Auth manages its own schema
// shape; we conform to its column names and use text PKs as the framework
// expects (not our uuid+public_id mixin).
export const sessions = authSchema.table(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // How this session was established: "sso:<providerId>" for an enterprise
    // SSO sign-in, otherwise "password", "social:<provider>" or "other".
    // Written once by the session.create.before hook in packages/auth and
    // never by a client (input:false). The org gate reads it to enforce an
    // organisation's "require SSO" policy (ADR-142). NULL on sessions created
    // before the column existed, which the gate treats as not SSO.
    authMethod: text("auth_method"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("sessions_token_idx").on(t.token),
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

export const accounts = authSchema.table(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),

    // Better Auth's drizzle adapter writes these fields on every OAuth account
    // create/link; without the columns it throws "field does not exist" and
    // sign-in fails. Nullable because these hold LOGIN-client tokens only
    // (minimal openid/profile/email scopes — low value); the high-value
    // DATA-client tokens use a separate client and never land here. The *_enc
    // columns below are the authoritative, encrypted copy.
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),

    // Envelope-encrypted token columns — authoritative.
    accessTokenEnc: bytea("access_token_enc"),
    refreshTokenEnc: bytea("refresh_token_enc"),
    idTokenEnc: bytea("id_token_enc"),
    // The KMS CMK id used to wrap the DEK for this row. Stored so
    // per-row key rotation is possible without re-querying config.
    tokenKmsKeyId: text("token_kms_key_id"),

    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerAccountIdx: uniqueIndex("accounts_provider_account_idx").on(
      t.providerId,
      t.accountId,
    ),
    userIdx: index("accounts_user_idx").on(t.userId),
  }),
);

export const verifications = authSchema.table(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    identifierIdx: index("verifications_identifier_idx").on(t.identifier),
  }),
);

// ── Better Auth rate-limit store ─────────────────────────────────────────────
// Used when `rateLimit.storage: "database"` is configured in betterAuth().
// Better Auth resolves this table via the model name "rateLimit"; the Drizzle
// adapter schema map in auth.ts wires "rateLimit" → this table export.
//
// Schema matches what the Better Auth rate-limiter creates/reads:
//   id          — text PK (Better Auth generates the id).
//   key         — text UNIQUE: composite of IP + path (the rate-limit bucket).
//   count       — integer: request count within the current window.
//   lastRequest — bigint: Date.now() milliseconds since epoch of the last hit.
//
// Migration: 0003_soc2_auth_hardening.sql
export const rateLimitTable = authSchema.table(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull().default(0),
    // bigint mode:"number" — JS can safely represent up to 2^53 ms (year ~287401)
    // which is more than sufficient for epoch milliseconds.
    lastRequest: bigint("lastRequest", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    keyIdx: uniqueIndex("rate_limit_key_idx").on(t.key),
  }),
);

// ── Better Auth two-factor (TOTP) store ──────────────────────────────────────
// Written by the Better Auth twoFactor plugin. Because the Drizzle adapter is
// configured with usePlural:true, the plugin's model name "twoFactor" is
// pluralized to "twoFactors" for schema-key lookup — the schema map in auth.ts
// therefore wires the key "twoFactors" → this export. The PHYSICAL table name
// (two_factor) is independent of that key, exactly like rate_limit above.
//
// Columns match what the Better Auth twoFactor plugin creates/reads. The JS
// property names MUST equal the plugin's field names (id, userId, secret,
// backupCodes, verified) — the Drizzle adapter resolves columns by JS-property
// lookup and translates camelCase → snake_case when emitting SQL. Like the
// other Better-Auth-managed tables (sessions/accounts), id is text (BA
// generates it) while userId is uuid to match users.id. secret and backupCodes
// are encrypted at rest by Better Auth before they reach the DB.
export const twoFactorTable = authSchema.table(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
  },
  (t) => ({
    userIdIdx: index("two_factor_user_id_idx").on(t.userId),
  }),
);

// ── Enterprise SSO providers (ADR-142) ───────────────────────────────────────
//
// One row per OIDC or SAML identity provider an organisation registers. The
// @better-auth/sso plugin reads this table through the Drizzle adapter as its
// "ssoProvider" model (pluralised to "ssoProviders" by usePlural:true), so the
// JS property names MUST equal the plugin's field names: id, issuer,
// oidcConfig, samlConfig, userId, providerId, organizationId, domain,
// domainVerified. The columns after those are Oxagen's own.
//
// SECRETS: oidc_config and saml_config are JSON text the plugin parses. Every
// secret inside them (the OIDC client secret, SAML private keys and their
// passphrases) is stored as an envelope-encrypted token ("enc:v1:<keyId>:…",
// see @oxagen/database/sso-secrets), never as plaintext. The auth adapter
// opens those tokens on read, so the plugin sees a usable config and the
// column never holds one.
//
// NO RLS. Like every Better Auth table this is read before a tenant scope
// exists (the sign-in request has no org yet), through the unscoped adapter.
// organization_id is therefore spelled the plugin's way and is not an org_id
// column the tenant-policy manifest would police. Oxagen's handlers write it
// through withSystemDb and pin organization_id in every predicate.
export const ssoProviderTable = authSchema.table(
  "sso_providers",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    oidcConfig: text("oidc_config"),
    samlConfig: text("saml_config"),
    // The org admin who registered the provider.
    userId: uuid("user_id"),
    // Stable slug used in callback URLs: /api/auth/sso/callback/<providerId>.
    providerId: text("provider_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    // The email domain this provider signs people in for, lowercased.
    domain: text("domain").notNull(),
    // True once the org proved it owns `domain` with a DNS TXT record. The
    // plugin refuses to sign anyone in through an unverified provider.
    domainVerified: boolean("domain_verified").notNull().default(false),
    // Oxagen columns.
    protocol: text("protocol").notNull(),
    displayName: text("display_name").notNull(),
    // The claim (OIDC) or attribute (SAML) that carries the person's groups.
    groupsClaim: text("groups_claim").notNull().default("groups"),
    // Token the org publishes as a DNS TXT record to prove it owns `domain`.
    domainVerificationToken: text("domain_verification_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerIdIdx: uniqueIndex("sso_providers_provider_id_idx").on(
      t.providerId,
    ),
    // One organisation per email domain: a second org cannot claim a domain
    // another org already registered, verified or not.
    domainIdx: uniqueIndex("sso_providers_domain_idx").on(t.domain),
    orgIdx: index("sso_providers_organization_id_idx").on(t.organizationId),
    protocolCheck: check(
      "sso_providers_protocol_check",
      sql`${t.protocol} IN ('oidc', 'saml')`,
    ),
    configCheck: check(
      "sso_providers_config_check",
      sql`(${t.protocol} = 'oidc' AND ${t.oidcConfig} IS NOT NULL AND ${t.samlConfig} IS NULL)
       OR (${t.protocol} = 'saml' AND ${t.samlConfig} IS NOT NULL AND ${t.oidcConfig} IS NULL)`,
    ),
  }),
);

// ── User preferences ─────────────────────────────────────────────────────────
// 1:1 with auth.users; cross-org (not org-scoped) since UI preferences belong
// to the person, not to a specific workspace. ON DELETE CASCADE so the row is
// garbage-collected when the user account is hard-deleted.
//
// Nullable model columns: NULL means "no explicit preference → inherit from
// workspace default → fall back to system default." Explicit model slug wins
// over tier alias wins over system default.

export const userPreferences = authSchema.table(
  "user_preferences",
  {
    ...idMixin("upr"),
    ...auditMixin(),
    ...softDeleteMixin(),
    // 1:1 enforced by uniqueIndex below. CASCADE deletes the preferences row
    // when the parent user row is hard-deleted (matches the FK below).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // UI appearance
    fontSize: fontSizeEnum("font_size").notNull().default("medium"),
    density: densityEnum("density").notNull().default("comfortable"),
    // Input behaviour: false = Enter inserts newline; true = Enter submits.
    enterToSubmit: boolean("enter_to_submit").notNull().default(false),
    // Agent interaction: what to do while a response is in flight.
    pendingPromptBehavior: pendingPromptBehaviorEnum("pending_prompt_behavior")
      .notNull()
      .default("queue"),
    // Text model preferences (user level; workspace level overrides available
    // separately). Image/video defaults were dropped with media generation
    // (ADR-043).
    defaultTextTier: modelTierEnum("default_text_tier"),
    defaultTextModel: text("default_text_model"),
    // Account-level preferences (distinct from the UI/model prefs above) —
    // surfaced by user.preferences.get / user.preferences.update.
    theme: text("theme").notNull().default("system"),
    language: text("language").notNull().default("en"),
    // Pacific time (migration 20260919120000). `DEFAULT_TIME_ZONE` in
    // @oxagen/oxagen/contracts/user.preferences.read carries the same value
    // for the handlers and the app; this package sits below the contracts.
    timezone: text("timezone").notNull().default("America/Los_Angeles"),
    notificationSettings: jsonb("notification_settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Per-turn dollar budget (the user's default; a turn may override it at
    // submit time). OFF by default — enabled=false means turns run with no
    // dollar ceiling. When enabled, `perTurnBudgetUsd` is the ceiling and
    // `perTurnBudgetMode` decides what happens at it (grace/prompt/enforce).
    perTurnBudgetEnabled: boolean("per_turn_budget_enabled")
      .notNull()
      .default(false),
    // Ceiling in USD; NULL when no limit is set. Nullable so "enabled but no
    // amount yet" is representable (the UI then prompts for a figure).
    perTurnBudgetUsd: real("per_turn_budget_usd"),
    // Enforcement mode: "grace" | "prompt" | "enforce" (validated by the
    // budget.policy contracts). Text-with-default mirrors theme/language above.
    perTurnBudgetMode: text("per_turn_budget_mode").notNull().default("prompt"),
    // grace mode: fraction ABOVE the limit allowed before a hard stop (0.25 = 25%).
    perTurnBudgetGracePct: real("per_turn_budget_grace_pct")
      .notNull()
      .default(0.25),
  },
  (t) => ({
    // Enforces the 1:1 relationship — one preferences row per user.
    userIdIdx: uniqueIndex("user_preferences_user_id_idx").on(t.userId),
  }),
);

/**
 * workspace_user_preferences — per-(user, workspace) coding-agent defaults.
 *
 * Distinct from `user_preferences` (which is user-GLOBAL / un-scoped): a
 * default repository and default environment are inherently workspace-scoped —
 * the same user has a different repo/environment in each workspace they belong
 * to. This table is org/workspace-scoped (RLS-governed via orgScopeMixin) and
 * 1:1 per (user, workspace).
 *
 * It also records whether we've shown the one-time "set a default repo?" prompt
 * (`repoDefaultPromptedAt`), so the app surface only asks once — the first time
 * the user opens the repo selector and has no default yet.
 */
export const workspaceUserPreferences = authSchema.table(
  "workspace_user_preferences",
  {
    ...idMixin("wup"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The user's preferred default repo for coding tasks in this workspace,
    // stored as the source_connections.public_id (con_…). NULL = no default.
    // Not an FK: source_connections lives in the ingestion schema and can be
    // soft-deleted; the app resolves + validates the connection at read time.
    defaultRepoConnectionId: text("default_repo_connection_id"),
    // The repo slug (owner/repo) the default connection resolved to, denormalized
    // for display so the selector can label the default without a second lookup.
    defaultRepoSlug: text("default_repo_slug"),
    // The user's preferred default environment (environments.public_id, env_…).
    // NULL = fall back to the workspace's isDefault environment.
    defaultEnvironmentId: text("default_environment_id"),
    // The user's preferred default agent for this workspace, stored as the
    // agents.public_id (agt_…). NULL = no default → the app falls back to its
    // built-in selection. Not an FK: agents live in the agent schema and can be
    // soft-deleted; the app resolves + validates the agent at read time.
    defaultAgentId: text("default_agent_id"),
    // When the one-time repo-default prompt was shown/answered. NULL = never
    // prompted → the app should offer the prompt on first repo-selector open.
    repoDefaultPromptedAt: timestamp("repo_default_prompted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    // One preferences row per (user, workspace).
    userWorkspaceIdx: uniqueIndex(
      "workspace_user_preferences_user_workspace_idx",
    ).on(t.userId, t.workspaceId),
  }),
);
