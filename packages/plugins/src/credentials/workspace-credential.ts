/**
 * Persists per-(workspace × org_listing) plugin credentials in mcp.credentials,
 * envelope-encrypted via the credential service. NEVER logs plaintext.
 */
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { resolveCredentialKms } from "./kms";
import {
  encryptCredentialSecrets,
  decryptCredentialSecrets,
} from "./credential-service";

// Module-level guard: log the missing-key misconfiguration at most once per
// process so the deployment ops alert is visible without spamming every read.
let kmsAbsentWarned = false;

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
  lastRefreshedAt?: Date | null;
}

/** Returns the credential row id. Throws if no encryption key is configured. */
export async function setWorkspaceSecret(
  input: SetWorkspaceSecretInput,
): Promise<string> {
  const kms = resolveCredentialKms();
  if (!kms)
    throw new Error(
      "[plugins] AUTH_TOKEN_ENCRYPTION_KEY required to store credentials",
    );
  const enc = await encryptCredentialSecrets(
    {
      secret: input.secret,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      oauthClientSecret: input.oauthClientSecret,
    },
    kms,
  );
  // Partial-update semantics: the OAuth flow persists this row in two distinct
  // phases against the same (workspaceId, orgListingId) — saveClientInformation()
  // writes only the DCR client id/secret, then saveTokens() writes only the
  // access/refresh tokens. A field absent from `input` (key undefined) must be
  // PRESERVED on conflict; only explicitly-provided fields (including an explicit
  // null, which clears the value) are written. Unconditionally writing every
  // column would let the token write null out the just-stored DCR client id and
  // break the next refresh.
  const set: Record<string, unknown> = {
    authKind: input.authKind,
    status: "active",
    updatedAt: new Date(),
  };
  if (input.secret !== undefined) set["secretEnc"] = enc.secretEnc;
  if (input.accessToken !== undefined)
    set["accessTokenEnc"] = enc.accessTokenEnc;
  if (input.refreshToken !== undefined)
    set["refreshTokenEnc"] = enc.refreshTokenEnc;
  if (input.oauthClientSecret !== undefined) {
    set["oauthClientSecretEnc"] = enc.oauthClientSecretEnc;
  }
  // tokenKmsKeyId tracks whichever secret columns were (re)encrypted this write;
  // only update it when at least one secret column is being written.
  if (
    input.secret !== undefined ||
    input.accessToken !== undefined ||
    input.refreshToken !== undefined ||
    input.oauthClientSecret !== undefined
  ) {
    set["tokenKmsKeyId"] = enc.tokenKmsKeyId;
  }
  if (input.oauthClientId !== undefined)
    set["oauthClientId"] = input.oauthClientId ?? null;
  if (input.scopes !== undefined) set["scopes"] = input.scopes;
  if (input.expiresAt !== undefined) set["expiresAt"] = input.expiresAt ?? null;
  if (input.lastRefreshedAt !== undefined) {
    set["lastRefreshedAt"] = input.lastRefreshedAt ?? null;
  }

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
        lastRefreshedAt: input.lastRefreshedAt ?? null,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [
          schema.mcpCredentials.workspaceId,
          schema.mcpCredentials.orgListingId,
        ],
        set,
      })
      .returning({ id: schema.mcpCredentials.id });
    if (!row) throw new Error("[plugins] credential upsert returned no row");
    return row.id;
  });
}

export interface WorkspaceCredentialStatus {
  orgListingId: string;
  authKind: string;
  /** active | needs_reauth | revoked */
  status: string;
  expiresAt: Date | null;
}

/**
 * Status-only bulk read for UI display (which installs are connected / need
 * (re)auth). Never touches the encrypted columns, so it needs no KMS key and
 * is safe to call from any server-rendered settings page.
 */
export async function listWorkspaceCredentialStatuses(key: {
  orgId: string;
  workspaceId: string;
}): Promise<WorkspaceCredentialStatus[]> {
  return withSystemDb(async (tx) =>
    tx
      .select({
        orgListingId: schema.mcpCredentials.orgListingId,
        authKind: schema.mcpCredentials.authKind,
        status: schema.mcpCredentials.status,
        expiresAt: schema.mcpCredentials.expiresAt,
      })
      .from(schema.mcpCredentials)
      .where(
        and(
          // withSystemDb bypasses RLS — the orgId predicate is the tenant guard.
          eq(schema.mcpCredentials.orgId, key.orgId),
          eq(schema.mcpCredentials.workspaceId, key.workspaceId),
        ),
      ),
  );
}

/**
 * Deletes the credential row for a (workspace × org_listing) — the "Remove
 * authentication" action. Touches no encrypted columns (nothing is decrypted),
 * so it needs no KMS key. Returns true when a row was deleted, false when no
 * credential existed for the key.
 */
export async function deleteWorkspaceSecret(key: {
  orgId: string;
  workspaceId: string;
  orgListingId: string;
}): Promise<boolean> {
  return withSystemDb(async (tx) => {
    const deleted = await tx
      .delete(schema.mcpCredentials)
      .where(
        and(
          // Defense-in-depth tenant scoping: withSystemDb bypasses RLS, so the
          // orgId predicate is the only guard preventing a caller from deleting
          // another tenant's credential by supplying a foreign
          // (workspaceId, orgListingId) pair.
          eq(schema.mcpCredentials.orgId, key.orgId),
          eq(schema.mcpCredentials.workspaceId, key.workspaceId),
          eq(schema.mcpCredentials.orgListingId, key.orgListingId),
        ),
      )
      .returning({ id: schema.mcpCredentials.id });
    return deleted.length > 0;
  });
}

export interface WorkspaceSecret {
  secret: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  oauthClientSecret: string | null;
  /** DCR client_id stored in the credential row (not encrypted). */
  oauthClientId: string | null;
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
  if (!kms) {
    // AUTH_TOKEN_ENCRYPTION_KEY is absent. Returning null here is type-identical
    // to "no credential row exists" at the call site, which silently presents
    // every plugin as unconnected in a misconfigured deployment. Log the
    // misconfiguration prominently so it is distinguishable from a genuine
    // absent-credential path. Warn at most once per process to avoid spam.
    if (!kmsAbsentWarned) {
      kmsAbsentWarned = true;
      console.error(
        "[plugins] getWorkspaceSecret: AUTH_TOKEN_ENCRYPTION_KEY is not set — " +
          "all plugin credentials are unreadable and plugins will appear 'not connected'. " +
          "Set AUTH_TOKEN_ENCRYPTION_KEY in the deployment environment to restore access.",
        { workspaceId: key.workspaceId, orgListingId: key.orgListingId },
      );
    }
    return null;
  }
  const row = await withSystemDb(async (tx) => {
    const [r] = await tx
      .select()
      .from(schema.mcpCredentials)
      .where(
        and(
          // Defense-in-depth tenant scoping: withSystemDb bypasses RLS, so the
          // orgId predicate is the only guard preventing a caller from reading
          // another tenant's decrypted credential by supplying a foreign
          // (workspaceId, orgListingId) pair.
          eq(schema.mcpCredentials.orgId, key.orgId),
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
    oauthClientId: row.oauthClientId ?? null,
    authKind: row.authKind,
    status: row.status,
  };
}
