import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { decrypt, resolveIngestionCryptoAdapterForKeyId } from "@oxagen/crypto";
// Self-reference the package barrel (not ./app-auth) on purpose: consumers mock
// the `@oxagen/github` module in their unit tests to stub installation-token
// minting, and that mock only intercepts this exact specifier.
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

/**
 * Minimal tenant scope resolveGitHubToken needs. A full `CapabilityContext`
 * (from @oxagen/oxagen) is structurally assignable, so existing callers pass
 * their `ctx` unchanged — this keeps @oxagen/github free of an @oxagen/oxagen
 * dependency.
 */
export interface GitHubWorkspaceScope {
  orgId: string;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Per-workspace GitHub token resolution chain
// (see docs/adr/ADR-020-per-workspace-github-write-credentials.md)
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

export async function resolveGitHubToken(
  ctx: GitHubWorkspaceScope,
): Promise<string> {
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
    // `!= null` (not `!== undefined`): deliveryConfig is JSONB, so an absent
    // installation can arrive as a literal `null`, which would otherwise be
    // minted as the string "null" and 404 against GitHub.
    if (installationId != null && appId && privateKey) {
      try {
        const { token } = await getInstallationToken({
          appId,
          privateKey,
          installationId,
        });
        return token;
      } catch (err) {
        // Installation token minting failed (e.g. 404 invalid installation ID,
        // or App misconfiguration). Fall back to OAuth token path.
        console.warn(
          `GitHub App token mint failed for installation ${installationId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
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
        // Route by the envelope's stored keyId, NOT the current provider env
        // var — the token may have been wrapped under a different provider
        // (e.g. AWS KMS) than this runtime is currently configured for.
        const { adapter } = resolveIngestionCryptoAdapterForKeyId(enc.keyId);
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
  if (envToken) {
    // This PAT is shared by the whole process, so using it in production would
    // let any workspace act with one identity instead of its own. We warn
    // instead of throwing: refusing outright could break a running deployment,
    // so we make the misconfiguration visible and let the operator fix it.
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[github-token] GITHUB_PERSONAL_ACCESS_TOKEN is set in production and is being used as a fallback. " +
          "This shared PAT bypasses per-workspace credential resolution (GitHub App installation token + " +
          "KMS-encrypted per-workspace OAuth), which is live. UNSET GITHUB_PERSONAL_ACCESS_TOKEN in production " +
          "and connect GitHub per workspace instead.",
      );
    }
    return envToken;
  }

  // ── Path 4: no credentials available ─────────────────────────────────
  throw new Error(
    "No GitHub connection for this workspace — connect GitHub in Settings, or set GITHUB_PERSONAL_ACCESS_TOKEN for local dev.",
  );
}
