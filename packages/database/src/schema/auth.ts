<<<<<<< HEAD
import { bigint, boolean, index, integer, text, timestamp, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
=======
import { bigint, boolean, customType, index, integer, text, timestamp, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
>>>>>>> feat/hardening-cost-prompts-motion-rebrand
import { authSchema } from "./_schemas";
import { auditMixin, bytea, citext, idMixin, softDeleteMixin, orgScopeMixin } from "./_mixins";

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
export const pendingPromptBehaviorEnum = authSchema.enum("pending_prompt_behavior", [
  "queue",
  "interrupt",
]);

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
    username: citext("username"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull(),
    // Better Auth tracks email verification as a boolean; we also track the
    // verification timestamp for our own audit purposes.
    emailVerified: boolean("email_verified").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: "date" }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    usernameIdx: uniqueIndex("users_username_idx").on(t.username),
  }),
);

export const credentials = authSchema.table(
  "credentials",
  {
    ...idMixin("crd"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    provider: text("provider").notNull(),
    credentialType: text("credential_type").notNull(),
    encryptedPayload: bytea("encrypted_payload").notNull(),
    kmsKeyId: text("kms_key_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    orgIdx: index("credentials_org_idx").on(t.orgId, t.workspaceId),
    providerIdx: index("credentials_provider_idx").on(t.orgId, t.provider),
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
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    keyPrefixIdx: uniqueIndex("api_keys_key_prefix_idx").on(t.keyPrefix),
    orgIdx: index("api_keys_org_idx").on(t.orgId, t.workspaceId),
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
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
    // sign-in fails (OXA-1420's encrypt-only contract relied on a databaseHook
    // stripping them, which Better Auth does not apply on every write path).
    // Restored as nullable so OAuth login works. These hold LOGIN-client tokens
    // only (minimal openid/profile/email scopes — low value); the high-value
    // DATA-client tokens use a separate client and never land here. The *_enc
    // columns + token-encryption hook remain for proper re-encryption (OXA-1420
    // follow-up) once Better Auth's hook coverage is confirmed.
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),

    // OXA-1420: envelope-encrypted token columns — authoritative.
    accessTokenEnc: bytea("access_token_enc"),
    refreshTokenEnc: bytea("refresh_token_enc"),
    idTokenEnc: bytea("id_token_enc"),
    // The KMS CMK id used to wrap the DEK for this row.  Stored so that
    // per-row key rotation is possible without re-querying config.
    tokenKmsKeyId: text("token_kms_key_id"),

    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    providerAccountIdx: uniqueIndex("accounts_provider_account_idx").on(t.providerId, t.accountId),
    userIdx: index("accounts_user_idx").on(t.userId),
  }),
);

export const verifications = authSchema.table(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
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
    // Model preferences (user level; workspace level overrides available separately)
    defaultTextTier: modelTierEnum("default_text_tier"),
    defaultTextModel: text("default_text_model"),
    defaultImageModel: text("default_image_model"),
    defaultVideoModel: text("default_video_model"),
    // Account-level preferences (distinct from the UI/model prefs above) —
    // surfaced by user.preferences.get / user.preferences.update.
    theme: text("theme").notNull().default("system"),
    language: text("language").notNull().default("en"),
    timezone: text("timezone").notNull().default("UTC"),
    notificationSettings: jsonb("notification_settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => ({
    // Enforces the 1:1 relationship — one preferences row per user.
    userIdIdx: uniqueIndex("user_preferences_user_id_idx").on(t.userId),
  }),
);

