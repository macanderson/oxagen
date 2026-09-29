// Operator tokens (mcp-studio-spec, Authentication and Storage model; M8).
//
// An MCP Studio server with `auth.mode = "operator-oauth"` calls the upstream
// with the token of the person who operates the run, so the server's own
// permissions apply to that person. Each operator connects once through the
// connect route in apps/api/src/routes/v1/mcp-studio.oauth.ts, and the token
// lands here: one row per operator, per server, and per environment. An
// environment can name its own OAuth client and its own URL, so a token one
// environment's authorization server issued does not fit another.
//
// The tokens are envelope-encrypted with the MCP credential key, like
// `mcp.credentials`. `credential_id` is the OAuth client the server names
// (`oxagen:credential/<name>`), and deleting that client deletes the tokens
// issued to it. A server that names no client registers one per operator at
// connect time (RFC 7591), and that client's id and secret live on the row.
//
// `user_id` is `auth.users.id`, the `operator` M6's CredentialRequest carries.
// No foreign key reaches `workspace.workspace_users`: that table lives on the
// shared plane and this one on the organization's data plane (ADR-042). The
// resolver checks membership instead, and deletes the row of an operator who
// left the workspace.
//
// The migration that creates this table and its tenant policies is
// 20260928090000_mcp_operator_tokens.sql.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mcpSchema } from "./_schemas";
import { bytea, uuidv7Default } from "./_mixins";
import { mcpCredentials } from "./mcp";

export const mcpOperatorTokens = mcpSchema.table(
  "operator_tokens",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    // The operator: auth.users.id.
    userId: uuid("user_id").notNull(),
    // The server's name in the steering repo: billing.
    server: text("server").notNull(),
    // The environment the token was issued for: sandbox.
    environment: text("environment").notNull(),
    // The OAuth client the server names, when it names one.
    credentialId: uuid("credential_id"),
    // The client the token was issued to. For a registered client the secret
    // is below; for a named client it is on the mcp.credentials row.
    clientId: text("client_id").notNull(),
    clientSecretEnc: bytea("client_secret_enc"),
    // Where refresh and revocation go, as discovery found them at connect.
    tokenEndpoint: text("token_endpoint").notNull(),
    revocationEndpoint: text("revocation_endpoint"),
    accessTokenEnc: bytea("access_token_enc").notNull(),
    refreshTokenEnc: bytea("refresh_token_enc"),
    tokenKmsKeyId: text("token_kms_key_id").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    // needs_reauth: the refresh token was refused, so the operator connects
    // again.
    status: text("status").notNull().default("active"),
    lastRefreshedAt: timestamp("last_refreshed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    operatorServerIdx: uniqueIndex("operator_tokens_operator_server_uq").on(
      t.workspaceId,
      t.userId,
      t.server,
      t.environment,
    ),
    orgIdx: index("operator_tokens_org_idx").on(t.orgId),
    credentialIdx: index("operator_tokens_credential_idx").on(t.credentialId),
    credentialFk: foreignKey({
      name: "operator_tokens_credential_fk",
      columns: [t.credentialId],
      foreignColumns: [mcpCredentials.id],
    }).onDelete("cascade"),
    statusCheck: check(
      "operator_tokens_status_check",
      sql`${t.status} IN ('active','needs_reauth')`,
    ),
    // SERVER_NAME_PATTERN and the manifest's environment name pattern.
    serverCheck: check(
      "operator_tokens_server_check",
      sql`${t.server} ~ '^[a-z][a-z0-9_]{0,23}$'`,
    ),
    environmentCheck: check(
      "operator_tokens_environment_check",
      sql`${t.environment} ~ '^[a-z][a-z0-9_]{0,31}$'`,
    ),
  }),
);
