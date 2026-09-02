import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import {
  createIngestionCryptoAdapter,
  resolveIngestionCryptoAdapterForKeyId,
  decrypt,
  encrypt,
} from "@oxagen/crypto";
import type { AuthCredential } from "@oxagen/ingestion/connectors";
import { logger } from "../logger";
import {
  refreshOAuthToken,
  isRefreshError,
  PERMANENT_ERRORS,
} from "./oauth-strategies";

/**
 * Resolve a source connection's stored credentials into an in-memory
 * AuthCredential the connector's poll() can use.
 *
 * Credential precedence (a connection uses exactly one):
 *   1. oauth_accounts  (org-level OAuth, linked via source_connections.oauth_account_id)
 *   2. oauth_tokens    (per-connection OAuth)
 *   3. auth_credentials (non-OAuth schemes: api_key, connection_string, …)
 *
 * For the OAuth paths this refreshes an access token that is expired or within
 * REFRESH_SKEW_MS of expiry, using the stored refresh token and the shared
 * provider strategy table, then persists the rotated tokens (Postgres stays the
 * source of truth). OAuth is surfaced to the connector as a bearer_token — a
 * connector's poll() only ever sees a usable credential, never an oauth2 marker.
 *
 * Returns null when no usable credential exists (never provisioned, or a
 * permanent refresh failure). The caller treats null as a poll failure so the
 * connection's health degrades and the UI can prompt a reconnect.
 *
 * SECURITY: decrypted tokens live only in local variables for the duration of
 * one poll; they are never logged and never returned from an Inngest step.
 */

/** Refresh an access token this close to (or past) expiry before polling. */
const REFRESH_SKEW_MS = 2 * 60 * 1000; // 2 minutes

type Envelope = { keyId: string; ciphertext: string };

function isEnvelope(v: unknown): v is Envelope {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Envelope).keyId === "string" &&
    typeof (v as Envelope).ciphertext === "string"
  );
}

async function decryptEnvelope(envelope: Envelope): Promise<string> {
  const { adapter } = resolveIngestionCryptoAdapterForKeyId(envelope.keyId);
  const cipherBuf = Buffer.from(envelope.ciphertext, "base64");
  const plain: unknown = await decrypt(cipherBuf, envelope.keyId, { adapter });
  return Buffer.isBuffer(plain) ? plain.toString("utf8") : String(plain);
}

async function encryptToEnvelope(plaintext: string): Promise<Envelope> {
  const writeAdapter = createIngestionCryptoAdapter();
  const cipher = await encrypt(plaintext, writeAdapter.keyId, {
    adapter: writeAdapter.adapter,
  });
  return { keyId: writeAdapter.keyId, ciphertext: cipher.toString("base64") };
}

export interface ResolvedConnectionAuth {
  auth: AuthCredential;
  deliveryConfig: Record<string, unknown>;
}

interface OAuthRow {
  access_token_enc: Envelope | null;
  refresh_token_enc: Envelope | null;
  expires_at: string | null;
  provider: string;
}

/**
 * Ensure a fresh access token for an OAuth row, refreshing inline if needed.
 * Returns the usable access token, or null on a permanent/failed refresh.
 * `persist` writes rotated tokens back to the row's own table.
 */
async function ensureFreshAccessToken(
  row: OAuthRow,
  persist: (
    access: Envelope,
    refresh: Envelope | null,
    expiresAt: Date | null,
  ) => Promise<unknown>,
): Promise<string | null> {
  if (!row.access_token_enc) return null;

  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const needsRefresh =
    expiresAt !== null && expiresAt.getTime() - Date.now() <= REFRESH_SKEW_MS;

  if (!needsRefresh) {
    return decryptEnvelope(row.access_token_enc);
  }

  // Expired/near-expiry: refresh if we have a refresh token, else fall back to
  // the (likely stale) access token and let the poll fail + degrade health.
  if (!row.refresh_token_enc) {
    logger.warn(
      { provider: row.provider },
      "resolve-connection-auth: access token expired and no refresh token — using stale token",
    );
    return decryptEnvelope(row.access_token_enc);
  }

  const refreshToken = await decryptEnvelope(row.refresh_token_enc);
  const result = await refreshOAuthToken(row.provider, refreshToken);

  if (isRefreshError(result)) {
    // A no-refresh provider (Linear PAT) never expires in practice — trust the
    // stored token. Genuine permanent errors surface as null → poll failure.
    if (result.error === "no_refresh_endpoint") {
      return decryptEnvelope(row.access_token_enc);
    }
    if (PERMANENT_ERRORS.has(result.error)) {
      logger.warn(
        { provider: row.provider, error: result.error },
        "resolve-connection-auth: refresh token revoked — connection needs reconnect",
      );
      return null;
    }
    logger.warn(
      { provider: row.provider, error: result.error },
      "resolve-connection-auth: token refresh failed transiently — using stale token",
    );
    return decryptEnvelope(row.access_token_enc);
  }

  const newAccessEnc = await encryptToEnvelope(result.accessToken);
  const newRefreshEnc = result.refreshToken
    ? await encryptToEnvelope(result.refreshToken)
    : null;
  const newExpiresAt = result.expiresInSec
    ? new Date(Date.now() + result.expiresInSec * 1000)
    : null;
  await persist(newAccessEnc, newRefreshEnc, newExpiresAt);

  return result.accessToken;
}

export async function resolveConnectionAuth(
  connectionId: string,
  orgId: string,
): Promise<ResolvedConnectionAuth | null> {
  // Load the connection shell: which credential store it points at.
  const connRows = await withSystemDb(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT delivery_config, oauth_account_id
      FROM   ingestion.source_connections
      WHERE  id     = ${connectionId}::uuid
      AND    org_id = ${orgId}::uuid
      AND    deleted_at IS NULL
      LIMIT  1
    `);
    return Array.from(rows) as Array<{
      delivery_config: Record<string, unknown> | null;
      oauth_account_id: string | null;
    }>;
  });

  const conn = connRows[0];
  if (!conn) return null;
  const deliveryConfig = conn.delivery_config ?? {};

  // ── Path 1: org-level OAuth account (source_connections.oauth_account_id) ──
  if (conn.oauth_account_id) {
    const accRows = await withSystemDb(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT access_token_enc, refresh_token_enc, expires_at, provider
        FROM   ingestion.oauth_accounts
        WHERE  id = ${conn.oauth_account_id}::uuid
        LIMIT  1
      `);
      return Array.from(rows) as unknown as OAuthRow[];
    });
    const acc = accRows[0];
    if (acc && isEnvelope(acc.access_token_enc)) {
      const token = await ensureFreshAccessToken(
        acc,
        (access, refresh, expiresAt) =>
          withSystemDb((tx) =>
            tx.execute(sql`
            UPDATE ingestion.oauth_accounts
            SET    access_token_enc  = ${JSON.stringify(access)}::jsonb,
                   refresh_token_enc = ${refresh ? JSON.stringify(refresh) : sql`refresh_token_enc`}::jsonb,
                   expires_at        = ${expiresAt ? expiresAt.toISOString() : null},
                   last_refreshed_at = NOW(),
                   refresh_failure_count = 0,
                   updated_at        = NOW()
            WHERE  id = ${conn.oauth_account_id}::uuid
          `),
          ),
      );
      if (!token) return null;
      return { auth: { scheme: "bearer_token", token }, deliveryConfig };
    }
  }

  // ── Path 2: per-connection OAuth (ingestion.oauth_tokens) ──────────────────
  const tokRows = await withSystemDb(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT access_token_enc, refresh_token_enc, expires_at
      FROM   ingestion.oauth_tokens
      WHERE  connection_id = ${connectionId}::uuid
      LIMIT  1
    `);
    return Array.from(rows) as Array<Omit<OAuthRow, "provider">>;
  });
  const tok = tokRows[0];
  if (tok && isEnvelope(tok.access_token_enc)) {
    // Per-connection tokens carry no provider column; derive it from the
    // connector so refresh can pick the right strategy.
    const provRows = await withSystemDb(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT connector_id FROM ingestion.source_connections
        WHERE id = ${connectionId}::uuid LIMIT 1
      `);
      return Array.from(rows) as Array<{ connector_id: string }>;
    });
    const provider = provRows[0]?.connector_id ?? "";
    const token = await ensureFreshAccessToken(
      { ...tok, provider },
      (access, refresh, expiresAt) =>
        withSystemDb((tx) =>
          tx.execute(sql`
          UPDATE ingestion.oauth_tokens
          SET    access_token_enc  = ${JSON.stringify(access)}::jsonb,
                 refresh_token_enc = ${refresh ? JSON.stringify(refresh) : sql`refresh_token_enc`}::jsonb,
                 expires_at        = ${expiresAt ? expiresAt.toISOString() : null},
                 last_refreshed_at = NOW(),
                 refresh_failure_count = 0,
                 updated_at        = NOW()
          WHERE  connection_id = ${connectionId}::uuid
        `),
        ),
    );
    if (!token) return null;
    return { auth: { scheme: "bearer_token", token }, deliveryConfig };
  }

  // ── Path 3: non-OAuth stored credential (ingestion.auth_credentials) ───────
  const credRows = await withSystemDb(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT encrypted_payload
      FROM   ingestion.auth_credentials
      WHERE  connection_id = ${connectionId}::uuid
      LIMIT  1
    `);
    return Array.from(rows) as Array<{ encrypted_payload: Envelope | null }>;
  });
  const cred = credRows[0];
  if (cred && isEnvelope(cred.encrypted_payload)) {
    const plaintext = await decryptEnvelope(cred.encrypted_payload);
    const auth = JSON.parse(plaintext) as AuthCredential;
    return { auth, deliveryConfig };
  }

  logger.warn(
    { connectionId, orgId },
    "resolve-connection-auth: no usable credential found for connection",
  );
  return null;
}
