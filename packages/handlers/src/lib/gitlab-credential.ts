// gitlab-credential.ts: the GitLab project access token a workspace connected
// (#3762), decrypted for one call and never logged.
//
// `attach_gitlab_project` stores the token and the webhook secret together as
// one encrypted payload in `ingestion.auth_credentials`, keyed by the GitLab
// source connection. This module is the only reader. It answers only for a
// live connection in the caller's workspace: a deleted, deleting or foreign
// connection has no credential here, so a revoked connection stops every
// GitLab call from the moment of the revoke.
//
// There is no fallback. GitHub has a local-only PAT fallback (ADR-020); GitLab
// deliberately has none, because a process-wide token would let one workspace
// act on another's project.
import { schema, withTenantDb } from "@oxagen/database";
import { decrypt, resolveIngestionCryptoAdapterForKeyId } from "@oxagen/crypto";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, isNull, notInArray } from "drizzle-orm";

/** The connector id a GitLab project connection carries. */
export const GITLAB_PROVIDER = "gitlab";

/** The `auth_scheme` a GitLab project connection carries. */
export const GITLAB_AUTH_SCHEME = "project_access_token";

/** What the encrypted payload holds. Both fields are secrets. */
export interface GitLabCredential {
  /** The project access token every GitLab call authenticates with. */
  token: string;
  /** The secret GitLab echoes in `X-Gitlab-Token` on every webhook delivery. */
  webhookSecret: string;
}

interface EncryptedEnvelope {
  keyId: string;
  ciphertext: string;
}

const RETIRED_STATUSES = ["deleting", "deleted"] as const;

/** The refusal for a workspace whose GitLab connection has no usable token. */
export function gitlabNotConnected(): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "gitlab_not_connected",
    message:
      "This workspace has no live GitLab project connection. Connect the project again with a project access token.",
  });
}

/**
 * Parse a decrypted payload. Anything without both secrets is treated as no
 * credential, so a malformed row refuses instead of calling GitLab with an
 * empty token.
 */
export function parseGitLabCredential(plain: string): GitLabCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  const row = parsed as Partial<GitLabCredential> | null;
  if (
    !row ||
    typeof row.token !== "string" ||
    row.token.length === 0 ||
    typeof row.webhookSecret !== "string" ||
    row.webhookSecret.length === 0
  )
    return null;
  return { token: row.token, webhookSecret: row.webhookSecret };
}

/** Decrypt a stored envelope under the key it was wrapped with. */
export async function decryptGitLabCredential(
  envelope: unknown,
): Promise<GitLabCredential | null> {
  const enc = envelope as Partial<EncryptedEnvelope> | null;
  if (
    !enc ||
    typeof enc.keyId !== "string" ||
    typeof enc.ciphertext !== "string"
  )
    return null;
  // Route by the envelope's own keyId, not the current provider env var, so a
  // token wrapped before a KMS switch still decrypts.
  const { adapter } = resolveIngestionCryptoAdapterForKeyId(enc.keyId);
  const plain = await decrypt(
    Buffer.from(enc.ciphertext, "base64"),
    enc.keyId,
    { adapter },
  );
  return parseGitLabCredential(plain.toString("utf8"));
}

/**
 * The credential of one live GitLab connection in the caller's workspace.
 * Refuses `gitlab_not_connected` when the connection is retired, belongs to
 * another workspace, or holds no readable credential.
 */
export async function resolveGitLabCredential(scope: {
  orgId: string;
  workspaceId: string;
  connectionId: string;
}): Promise<GitLabCredential> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ encryptedPayload: schema.authCredentials.encryptedPayload })
      .from(schema.sourceConnections)
      .innerJoin(
        schema.authCredentials,
        eq(schema.authCredentials.connectionId, schema.sourceConnections.id),
      )
      .where(
        and(
          eq(schema.sourceConnections.id, scope.connectionId),
          eq(schema.sourceConnections.orgId, scope.orgId),
          eq(schema.sourceConnections.workspaceId, scope.workspaceId),
          eq(schema.sourceConnections.connectorId, GITLAB_PROVIDER),
          isNull(schema.sourceConnections.deletedAt),
          notInArray(schema.sourceConnections.status, [...RETIRED_STATUSES]),
        ),
      )
      .limit(1),
  );
  const credential = row
    ? await decryptGitLabCredential(row.encryptedPayload)
    : null;
  if (!credential) throw gitlabNotConnected();
  return credential;
}
