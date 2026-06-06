/**
 * Persists per-(workspace × org_listing) plugin credentials in mcp.credentials,
 * envelope-encrypted via the Plan 1 credential service. NEVER logs plaintext.
 */
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { resolveCredentialKms } from "./kms";
import {
  encryptCredentialSecrets,
  decryptCredentialSecrets,
} from "./credential-service";

export interface SetWorkspaceSecretInput {
  orgId: string;
  workspaceId: string;
  orgListingId: string;
  authKind: "oauth" | "secret";
  secret?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  scopes?: string[];
  expiresAt?: Date | null;
}

/** Returns the credential row id. Throws if no encryption key is configured. */
export async function setWorkspaceSecret(input: SetWorkspaceSecretInput): Promise<string> {
  const kms = resolveCredentialKms();
  if (!kms) throw new Error("[plugins] AUTH_TOKEN_ENCRYPTION_KEY required to store credentials");
  const enc = await encryptCredentialSecrets(
    {
      secret: input.secret,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      oauthClientSecret: input.oauthClientSecret,
    },
    kms,
  );
  return withSystemDb(async (tx) => {
    const [row] = await tx
      .insert(schema.mcpCredentials)
      .values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        orgListingId: input.orgListingId,
        authKind: input.authKind,
        secretEnc: enc.secretEnc,
        accessTokenEnc: enc.accessTokenEnc,
        refreshTokenEnc: enc.refreshTokenEnc,
        oauthClientSecretEnc: enc.oauthClientSecretEnc,
        tokenKmsKeyId: enc.tokenKmsKeyId,
        oauthClientId: input.oauthClientId ?? null,
        scopes: input.scopes ?? [],
        expiresAt: input.expiresAt ?? null,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [schema.mcpCredentials.workspaceId, schema.mcpCredentials.orgListingId],
        set: {
          authKind: input.authKind,
          secretEnc: enc.secretEnc,
          accessTokenEnc: enc.accessTokenEnc,
          refreshTokenEnc: enc.refreshTokenEnc,
          oauthClientSecretEnc: enc.oauthClientSecretEnc,
          tokenKmsKeyId: enc.tokenKmsKeyId,
          oauthClientId: input.oauthClientId ?? null,
          scopes: input.scopes ?? [],
          expiresAt: input.expiresAt ?? null,
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.mcpCredentials.id });
    if (!row) throw new Error("[plugins] credential upsert returned no row");
    return row.id;
  });
}

export interface WorkspaceSecret {
  secret: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  oauthClientSecret: string | null;
  authKind: string;
  status: string;
}

/** Loads + decrypts the credential for a (workspace × org_listing), or null. */
export async function getWorkspaceSecret(key: {
  orgId: string;
  workspaceId: string;
  orgListingId: string;
}): Promise<WorkspaceSecret | null> {
  const kms = resolveCredentialKms();
  if (!kms) return null;
  const row = await withSystemDb(async (tx) => {
    const [r] = await tx
      .select()
      .from(schema.mcpCredentials)
      .where(
        and(
          eq(schema.mcpCredentials.workspaceId, key.workspaceId),
          eq(schema.mcpCredentials.orgListingId, key.orgListingId),
        ),
      )
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;
  const dec = await decryptCredentialSecrets(
    {
      tokenKmsKeyId: row.tokenKmsKeyId,
      secretEnc: row.secretEnc,
      accessTokenEnc: row.accessTokenEnc,
      refreshTokenEnc: row.refreshTokenEnc,
      oauthClientSecretEnc: row.oauthClientSecretEnc,
    },
    kms,
  );
  return {
    secret: dec.secret,
    accessToken: dec.accessToken,
    refreshToken: dec.refreshToken,
    oauthClientSecret: dec.oauthClientSecret,
    authKind: row.authKind,
    status: row.status,
  };
}
