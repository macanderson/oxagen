import type { CapabilityContext } from "@oxagen/oxagen";

/**
 * LOCAL / DEMO FALLBACK ONLY — see TODO below.
 *
 * TODO: Replace the env-var fallback with per-workspace credential resolution:
 *   1. Look up the workspace's GitHub connection in `ingestion.oauth_accounts`
 *      (or `mcp.credentials`, whichever table the connector dual-write lands the
 *      OAuth token in) using ctx.workspaceId.
 *   2. Decrypt with KMS (see packages/crypto / @oxagen/kms).
 *   3. Return the decrypted token.
 *
 * Until that is built, GITHUB_PERSONAL_ACCESS_TOKEN is an escape hatch for
 * local development and demo environments. It MUST NOT be set in production
 * without the per-workspace credential path implemented.
 */
export async function resolveGitHubToken(ctx: CapabilityContext): Promise<string> {
  // TODO: implement per-workspace credential lookup (see comment above)
  // const credential = await lookupOAuthCredential(ctx.workspaceId, "github");
  // if (credential) return await kmsDecrypt(credential.encryptedToken);

  void ctx; // reserved for future per-workspace credential resolution

  const envToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (envToken) return envToken;

  throw new Error(
    "No GitHub token available (connect GitHub or set GITHUB_PERSONAL_ACCESS_TOKEN)",
  );
}
