import { customType, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authSchema } from "./_schemas.js";
import { auditMixin, citext, idMixin, softDeleteMixin, tenantScopeMixin } from "./_mixins.js";

// bytea for encrypted_payload — Drizzle has no first-class bytea helper, so
// we declare it inline. KMS unwraps the payload at the credential service
// boundary; the column is opaque to the rest of the app.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

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
    ...tenantScopeMixin(),
    ...softDeleteMixin(),
    provider: text("provider").notNull(),
    credentialType: text("credential_type").notNull(),
    encryptedPayload: bytea("encrypted_payload").notNull(),
    kmsKeyId: text("kms_key_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    tenantIdx: index("credentials_tenant_idx").on(t.tenantId, t.workspaceId),
    providerIdx: index("credentials_provider_idx").on(t.tenantId, t.provider),
  }),
);

export const apiKeys = authSchema.table(
  "api_keys",
  {
    ...idMixin("aky"),
    ...auditMixin(),
    ...tenantScopeMixin(),
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
    tenantIdx: index("api_keys_tenant_idx").on(t.tenantId, t.workspaceId),
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
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
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

