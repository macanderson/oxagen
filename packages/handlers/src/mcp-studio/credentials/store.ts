// store.ts: where MCP Studio credentials live (mcp-studio-spec, Authentication
// and Storage model).
//
// A service credential is an mcp.credentials row, named by the <name> in
// `oxagen:credential/<name>`. An operator's token is an mcp.operator_tokens
// row, one per operator, server, and environment. The store reads and writes
// ciphertext only. The credential source decrypts a row for one call and
// encrypts what a token endpoint returns, so no plaintext secret passes
// through this module.
//
// Every read and write filters by the store's org and workspace and runs under
// row-level security, so a row from another workspace reads as absent.
import { schema, type Tx, withOrgDb, withSystemDb, withTenantDb } from "@oxagen/database";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, type SQL } from "drizzle-orm";
import { z } from "zod";

const credentials = schema.mcpCredentials;
const operatorTokens = schema.mcpOperatorTokens;
const verifications = schema.verifications;
const workspaceUsers = schema.workspaceUsers;

export interface CredentialScope {
  orgId: string;
  workspaceId: string;
}

/** The encrypted columns, with the key that sealed them. */
export interface SealedSecrets {
  tokenKmsKeyId: string | null;
  accessTokenEnc: Buffer | null;
  refreshTokenEnc: Buffer | null;
  secretEnc: Buffer | null;
  oauthClientSecretEnc: Buffer | null;
}

/** One mcp.credentials row. */
export interface StoredCredential extends SealedSecrets {
  id: string;
  name: string;
  /** oauth or secret. */
  authKind: string;
  /** active, needs_reauth, or revoked. */
  status: string;
  oauthClientId: string | null;
  scopes: string[];
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
}

/** What a token grant changes on an mcp.credentials row. */
export interface CredentialTokenUpdate {
  /** Every encrypted column, sealed again with the current key. */
  sealed: SealedSecrets & { tokenKmsKeyId: string };
  expiresAt: Date | null;
  scopes: string[];
  refreshedAt: Date;
}

/** One mcp.operator_tokens row. */
export interface StoredOperatorToken {
  id: string;
  userId: string;
  server: string;
  environment: string;
  credentialId: string | null;
  clientId: string;
  clientSecretEnc: Buffer | null;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer | null;
  tokenKmsKeyId: string;
  scopes: string[];
  expiresAt: Date | null;
  /** active or needs_reauth. */
  status: string;
  lastRefreshedAt: Date | null;
}

/** The row an operator's connect writes. */
export type NewOperatorToken = Omit<StoredOperatorToken, "id" | "status">;

/** What a refresh changes on an mcp.operator_tokens row. */
export interface OperatorTokenUpdate {
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer | null;
  clientSecretEnc: Buffer | null;
  tokenKmsKeyId: string;
  expiresAt: Date | null;
  scopes: string[];
  refreshedAt: Date;
}

export interface OperatorKey {
  userId: string;
  server: string;
  environment: string;
}

/** The credential rows of one workspace. */
export interface CredentialStore {
  credentialByName(name: string): Promise<StoredCredential | null>;
  credentialById(id: string): Promise<StoredCredential | null>;
  saveCredentialTokens(id: string, update: CredentialTokenUpdate): Promise<void>;
  markCredentialNeedsReauth(id: string): Promise<void>;
  operatorToken(key: OperatorKey): Promise<StoredOperatorToken | null>;
  /** Insert the operator's token, or replace the one the operator had. */
  saveOperatorToken(row: NewOperatorToken): Promise<void>;
  updateOperatorToken(id: string, update: OperatorTokenUpdate): Promise<void>;
  markOperatorTokenNeedsReauth(id: string): Promise<void>;
  /** True when a row was deleted. */
  deleteOperatorToken(id: string): Promise<boolean>;
  /** Every token the operator holds in this workspace. */
  operatorTokensOf(userId: string): Promise<StoredOperatorToken[]>;
  /** True while the person is a member of this workspace. */
  isMember(userId: string): Promise<boolean>;
}

const credentialColumns = {
  id: credentials.id,
  name: credentials.name,
  authKind: credentials.authKind,
  status: credentials.status,
  oauthClientId: credentials.oauthClientId,
  scopes: credentials.scopes,
  expiresAt: credentials.expiresAt,
  lastRefreshedAt: credentials.lastRefreshedAt,
  tokenKmsKeyId: credentials.tokenKmsKeyId,
  accessTokenEnc: credentials.accessTokenEnc,
  refreshTokenEnc: credentials.refreshTokenEnc,
  secretEnc: credentials.secretEnc,
  oauthClientSecretEnc: credentials.oauthClientSecretEnc,
};

const operatorTokenColumns = {
  id: operatorTokens.id,
  userId: operatorTokens.userId,
  server: operatorTokens.server,
  environment: operatorTokens.environment,
  credentialId: operatorTokens.credentialId,
  clientId: operatorTokens.clientId,
  clientSecretEnc: operatorTokens.clientSecretEnc,
  tokenEndpoint: operatorTokens.tokenEndpoint,
  revocationEndpoint: operatorTokens.revocationEndpoint,
  accessTokenEnc: operatorTokens.accessTokenEnc,
  refreshTokenEnc: operatorTokens.refreshTokenEnc,
  tokenKmsKeyId: operatorTokens.tokenKmsKeyId,
  scopes: operatorTokens.scopes,
  expiresAt: operatorTokens.expiresAt,
  status: operatorTokens.status,
  lastRefreshedAt: operatorTokens.lastRefreshedAt,
};

/** The Postgres store for one workspace. */
export function postgresCredentialStore(scope: CredentialScope): CredentialStore {
  const { orgId, workspaceId } = scope;
  const inScope = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runInTenantScope({ orgId, workspaceId }, () => withTenantDb(fn));
  const credentialIn = and(
    eq(credentials.orgId, orgId),
    eq(credentials.workspaceId, workspaceId),
  );
  const tokenIn = and(
    eq(operatorTokens.orgId, orgId),
    eq(operatorTokens.workspaceId, workspaceId),
  );

  const credentialWhere = async (
    where: SQL,
  ): Promise<StoredCredential | null> => {
    const [row] = await inScope((tx) =>
      tx
        .select(credentialColumns)
        .from(credentials)
        .where(and(credentialIn, where))
        .limit(1),
    );
    return row ?? null;
  };

  return {
    credentialByName: (name) => credentialWhere(eq(credentials.name, name)),
    credentialById: (id) => credentialWhere(eq(credentials.id, id)),

    async saveCredentialTokens(id, update) {
      await inScope((tx) =>
        tx
          .update(credentials)
          .set({
            ...update.sealed,
            expiresAt: update.expiresAt,
            scopes: update.scopes,
            status: "active",
            lastRefreshedAt: update.refreshedAt,
            updatedAt: update.refreshedAt,
          })
          .where(and(credentialIn, eq(credentials.id, id))),
      );
    },

    async markCredentialNeedsReauth(id) {
      await inScope((tx) =>
        tx
          .update(credentials)
          .set({ status: "needs_reauth", updatedAt: new Date() })
          .where(and(credentialIn, eq(credentials.id, id))),
      );
    },

    async operatorToken(key) {
      const [row] = await inScope((tx) =>
        tx
          .select(operatorTokenColumns)
          .from(operatorTokens)
          .where(
            and(
              tokenIn,
              eq(operatorTokens.userId, key.userId),
              eq(operatorTokens.server, key.server),
              eq(operatorTokens.environment, key.environment),
            ),
          )
          .limit(1),
      );
      return row ?? null;
    },

    async saveOperatorToken(row) {
      const now = new Date();
      const values = {
        credentialId: row.credentialId,
        clientId: row.clientId,
        clientSecretEnc: row.clientSecretEnc,
        tokenEndpoint: row.tokenEndpoint,
        revocationEndpoint: row.revocationEndpoint,
        accessTokenEnc: row.accessTokenEnc,
        refreshTokenEnc: row.refreshTokenEnc,
        tokenKmsKeyId: row.tokenKmsKeyId,
        scopes: row.scopes,
        expiresAt: row.expiresAt,
        status: "active",
        lastRefreshedAt: row.lastRefreshedAt,
      };
      await inScope((tx) =>
        tx
          .insert(operatorTokens)
          .values({
            orgId,
            workspaceId,
            userId: row.userId,
            server: row.server,
            environment: row.environment,
            ...values,
          })
          .onConflictDoUpdate({
            target: [
              operatorTokens.workspaceId,
              operatorTokens.userId,
              operatorTokens.server,
              operatorTokens.environment,
            ],
            set: { ...values, updatedAt: now },
          }),
      );
    },

    async updateOperatorToken(id, update) {
      await inScope((tx) =>
        tx
          .update(operatorTokens)
          .set({
            accessTokenEnc: update.accessTokenEnc,
            refreshTokenEnc: update.refreshTokenEnc,
            clientSecretEnc: update.clientSecretEnc,
            tokenKmsKeyId: update.tokenKmsKeyId,
            expiresAt: update.expiresAt,
            scopes: update.scopes,
            status: "active",
            lastRefreshedAt: update.refreshedAt,
            updatedAt: update.refreshedAt,
          })
          .where(and(tokenIn, eq(operatorTokens.id, id))),
      );
    },

    async markOperatorTokenNeedsReauth(id) {
      await inScope((tx) =>
        tx
          .update(operatorTokens)
          .set({ status: "needs_reauth", updatedAt: new Date() })
          .where(and(tokenIn, eq(operatorTokens.id, id))),
      );
    },

    async deleteOperatorToken(id) {
      const deleted = await inScope((tx) =>
        tx
          .delete(operatorTokens)
          .where(and(tokenIn, eq(operatorTokens.id, id)))
          .returning({ id: operatorTokens.id }),
      );
      return deleted.length > 0;
    },

    operatorTokensOf: (userId) =>
      inScope((tx) =>
        tx
          .select(operatorTokenColumns)
          .from(operatorTokens)
          .where(and(tokenIn, eq(operatorTokens.userId, userId))),
      ),

    async isMember(userId) {
      // tenancy: system bypass via withSystemDb (workspace membership lives on
      // the shared plane, ADR-042); the read is filtered by workspaceId and
      // userId and returns one id only.
      const rows = await withSystemDb((tx) =>
        tx
          .select({ id: workspaceUsers.id })
          .from(workspaceUsers)
          .where(
            and(
              eq(workspaceUsers.workspaceId, workspaceId),
              eq(workspaceUsers.userId, userId),
            ),
          )
          .limit(1),
      );
      return rows.length > 0;
    },
  };
}

/**
 * The workspaces of one organization where a person holds an operator token.
 * The paths that remove a person from an organization read this after the
 * removal commits, when the person belongs to no workspace there. It runs as
 * an organization-wide read (ADR-086): RLS still fences org_id, and the read
 * reaches every workspace of the organization.
 */
export function operatorTokenWorkspaces(orgId: string, userId: string): Promise<string[]> {
  return runInTenantScope({ orgId, workspaceId: ORG_ONLY_WORKSPACE_ID }, () =>
    withOrgDb(async (tx) => {
      const rows = await tx
        .selectDistinct({ workspaceId: operatorTokens.workspaceId })
        .from(operatorTokens)
        .where(and(eq(operatorTokens.orgId, orgId), eq(operatorTokens.userId, userId)));
      return rows.map((row) => row.workspaceId);
    }),
  );
}

/**
 * What the connect route remembers between sending an operator to the
 * authorization server and the callback. It holds no token. A client secret
 * that dynamic registration issued travels sealed.
 */
export const connectStateSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  server: z.string().min(1),
  environment: z.string().min(1),
  /** The server's label, for the page the callback shows. */
  label: z.string().min(1),
  credentialId: z.string().uuid().nullable(),
  clientId: z.string().min(1),
  /** base64 ciphertext of a registered client's secret, or null. */
  clientSecretSealed: z.string().nullable(),
  kmsKeyId: z.string().nullable(),
  /** Where the callback exchanges the code. */
  tokenEndpoint: z.string().url(),
  /** Where later refreshes go. The token row stores this one. */
  refreshEndpoint: z.string().url(),
  revocationEndpoint: z.string().url().nullable(),
  resource: z.string().nullable(),
  redirectUri: z.string().url(),
  codeVerifier: z.string().min(43).max(128),
  scopes: z.array(z.string()),
});
export type ConnectState = z.output<typeof connectStateSchema>;

/** Connect states, each good for one callback. */
export interface ConnectStateStore {
  save(state: string, data: ConnectState, expiresAt: Date): Promise<void>;
  /** Read and delete the state. Null when it is unknown, used, expired, or unreadable. */
  take(state: string, now: Date): Promise<ConnectState | null>;
}

const STATE_PREFIX = "mcp_studio_oauth:";

/** Connect states in auth.verifications, beside the plugin OAuth states. */
export const postgresConnectStateStore: ConnectStateStore = {
  async save(state, data, expiresAt) {
    const id = STATE_PREFIX + state;
    // tenancy: system bypass via withSystemDb (auth.verifications is a global
    // table on the shared plane with no org_id; the row is keyed by a random
    // state and carries the orgId and workspaceId the callback verified).
    await withSystemDb((tx) =>
      tx.insert(verifications).values({
        id,
        identifier: id,
        value: JSON.stringify(data),
        expiresAt,
      }),
    );
  },

  async take(state, now) {
    const id = STATE_PREFIX + state;
    // tenancy: system bypass via withSystemDb (auth.verifications is a global
    // table on the shared plane with no org_id; the delete is filtered by the
    // random state the signed-in operator's cookie carried).
    const [row] = await withSystemDb((tx) =>
      tx
        .delete(verifications)
        .where(eq(verifications.id, id))
        .returning({ value: verifications.value, expiresAt: verifications.expiresAt }),
    );
    if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      return null;
    }
    const parsed = connectStateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
};
