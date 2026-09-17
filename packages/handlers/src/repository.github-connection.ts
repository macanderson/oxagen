// repository.github-connection.ts — the workspace's GitHub App installation,
// read from the workspace's GitHub source connection (#2967).
//
// One implementation, shared by every repository capability that needs it:
// `bind_main_repository` mints an installation token with it,
// `list_installation_repositories` lists what that token can reach, and
// `get_main_repository` reports whether there is one at all. The caller never
// names an installation on any of the three — an installation id a caller
// could choose would let one tenant mint tokens for another account's
// installation, so it is always taken from the connection the HMAC-verified
// install callback attached (apps/api/src/routes/v1/github-oauth.ts).
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";

/** The connector id the GitHub install callback writes. */
export const GITHUB_PROVIDER = "github";

/**
 * Statuses that mean the connection is on its way out and must not mint
 * anything, even though its `deleted_at` is still null.
 *
 * `delete_connection` sets `status = 'deleting'` and leaves `deleted_at` for
 * the purge job that runs later, so `deleted_at IS NULL` alone does not mean
 * live. Without this, a person who deleted their GitHub connection would still
 * see it reported as connected, and `list_installation_repositories` and
 * `bind_main_repository` would go on minting installation tokens through it —
 * "revoking the connection stops the token minting" has to hold from the
 * moment of the revoke, not from whenever the purge catches up.
 */
const RETIRED_STATUSES = ["deleting", "deleted"] as const;

/** A workspace GitHub connection that carries an installation id. */
export interface WorkspaceGithubInstallation {
  /** The connection row's UUID — what a repository binding points at. */
  id: string;
  /** `con_…`, the id a surface may show. */
  publicId: string;
  status: string;
  /** Numeric GitHub installation id as text. Never sourced from caller input. */
  installationId: string;
}

/**
 * The installation id the install callback merged into a connection's
 * `deliveryConfig`, or null when the connection carries none.
 *
 * Accepts the number GitHub sends and the string a JSON round-trip leaves,
 * and rejects anything that is not a plain positive integer: the value is
 * interpolated into a GitHub API path, so a looser read would let a malformed
 * stored config retarget the request.
 */
export function installationIdOf(deliveryConfig: unknown): string | null {
  if (typeof deliveryConfig !== "object" || deliveryConfig === null)
    return null;
  const raw = (deliveryConfig as { installationId?: unknown }).installationId;
  if (typeof raw === "string" && /^[1-9]\d{0,19}$/.test(raw)) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0)
    return String(raw);
  return null;
}

/**
 * The workspace's GitHub connection carrying an installation, or null when it
 * has none — which is exactly the state `bind_main_repository` and
 * `list_installation_repositories` refuse as `conflict: github_not_connected`.
 *
 * A workspace may hold several GitHub connections (the legacy sources wizard
 * creates one per connect attempt). Rows are read newest-first by `created_at`
 * and the newest that carries an installation wins, so all three capabilities
 * agree on which installation the workspace acts through.
 *
 * Newest-first is not a preference, it is the same rule the install callback
 * applies when it attaches: `attachWorkspaceGithubInstallation`
 * (apps/api/src/routes/v1/github-oauth.ts) selects with the identical predicate
 * and `ORDER BY created_at DESC LIMIT 1`. With no ordering here, an unordered
 * scan could answer an older legacy connection while the callback had just
 * written the installation onto the newest one — writer and reader disagreeing
 * about which connection is authoritative, and the three repository
 * capabilities quietly acting through a stale installation. The predicate and
 * the ordering must both match for the row written to be the row read.
 */
export async function resolveWorkspaceGithubInstallation(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<WorkspaceGithubInstallation | null> {
  return withTenantDb(async (tx) => {
    const rows = await tx
      .select({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
        status: schema.sourceConnections.status,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, scope.orgId),
          eq(schema.sourceConnections.workspaceId, scope.workspaceId),
          eq(schema.sourceConnections.connectorId, GITHUB_PROVIDER),
          isNull(schema.sourceConnections.deletedAt),
          notInArray(schema.sourceConnections.status, [...RETIRED_STATUSES]),
        ),
      )
      // Same tie-break as the install callback's attach. See the doc comment.
      .orderBy(desc(schema.sourceConnections.createdAt));
    for (const row of rows) {
      const installationId = installationIdOf(row.deliveryConfig);
      if (installationId !== null) {
        return {
          id: row.id,
          publicId: row.publicId,
          status: row.status,
          installationId,
        };
      }
    }
    return null;
  });
}
