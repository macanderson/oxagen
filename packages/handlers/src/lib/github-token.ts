import type { CapabilityContext } from "@oxagen/oxagen";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { decrypt, createIngestionCryptoAdapter } from "@oxagen/crypto";
import { getInstallationToken } from "@oxagen/github";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DeliveryConfig {
  installationId?: string | number;
  [key: string]: unknown;
}

interface EncryptedToken {
  keyId: string;
  ciphertext: string;
}

// ---------------------------------------------------------------------------
// Per-workspace GitHub token resolution chain (ADR-020)
//
// Resolution order:
//   1. GitHub App installation access token — when the workspace connection
//      carries an installationId AND GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY
//      are both set. Short-lived (~1 h), bot identity, no stored secret,
//      workspace-scoped. Preferred for production.
//   2. Per-workspace OAuth token — decrypted from ingestion.oauth_accounts via
//      KMS. Requires the user to have connected GitHub via the OAuth flow. Acts
//      as the connecting user.
//   3. GITHUB_PERSONAL_ACCESS_TOKEN env var — local-only dev/demo fallback.
//      MUST NOT be set in production once per-workspace credentials are wired.
//   4. No token available → actionable error.
// ---------------------------------------------------------------------------

export async function resolveGitHubToken(ctx: CapabilityContext): Promise<string> {
  // ── Step 1: look up the workspace's GitHub source connection ─────────────
  const [connection] = await withTenantDb((tx) =>
    tx
      .select({
        oauthAccountId: schema.sourceConnections.oauthAccountId,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          eq(schema.sourceConnections.connectorId, "github"),
          eq(schema.sourceConnections.status, "connected"),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (connection) {
    const deliveryConfig =
      (connection.deliveryConfig as DeliveryConfig | null) ?? {};
    const installationId = deliveryConfig.installationId;
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    // ── Path 1: GitHub App installation token ────────────────────────────
    if (installationId !== undefined && appId && privateKey) {
      const { token } = await getInstallationToken({
        appId,
        privateKey,
        installationId,
      });
      return token;
    }

    // ── Path 2: stored per-workspace OAuth token (KMS-decrypted) ─────────
    if (connection.oauthAccountId) {
      const [account] = await withTenantDb((tx) =>
        tx
          .select({ accessTokenEnc: schema.oauthAccounts.accessTokenEnc })
          .from(schema.oauthAccounts)
          .where(
            eq(schema.oauthAccounts.id, connection.oauthAccountId as string),
          )
          .limit(1),
      );

      if (account?.accessTokenEnc) {
        const enc = account.accessTokenEnc as EncryptedToken;
        const { adapter } = createIngestionCryptoAdapter();
        const plain = await decrypt(
          Buffer.from(enc.ciphertext, "base64"),
          enc.keyId,
          { adapter },
        );
        return plain.toString("utf8");
      }
    }
  }

  // ── Path 3: local-only dev/demo env-var fallback ──────────────────────
  const envToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (envToken) return envToken;

  // ── Path 4: no credentials available ─────────────────────────────────
  throw new Error(
    "No GitHub connection for this workspace — connect GitHub in Settings, or set GITHUB_PERSONAL_ACCESS_TOKEN for local dev.",
  );
}
