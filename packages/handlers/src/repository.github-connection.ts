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
import { and, desc, eq, isNull, notInArray, type SQL } from "drizzle-orm";

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

/**
 * The one predicate that says which rows are "this workspace's live GitHub
 * connections". Every reader and every writer in the product uses it, because
 * a predicate two sides nearly share is two predicates: the day they diverge,
 * one attaches an installation to a row the other never reads, and the
 * repository capabilities go on acting through a stale installation with
 * nothing on screen to show for the connect that just succeeded.
 *
 * The install callback (apps/api/src/routes/v1/github-oauth.ts) states the
 * same predicate against the system seam, which it must: a public OAuth
 * redirect runs in no tenant scope. That copy names this one in its comment
 * and the two are asserted to agree by their tests.
 */
export function workspaceGithubConnectionFilter(scope: {
  orgId: string;
  workspaceId: string;
}): SQL | undefined {
  return and(
    eq(schema.sourceConnections.orgId, scope.orgId),
    eq(schema.sourceConnections.workspaceId, scope.workspaceId),
    eq(schema.sourceConnections.connectorId, GITHUB_PROVIDER),
    isNull(schema.sourceConnections.deletedAt),
    notInArray(schema.sourceConnections.status, [...RETIRED_STATUSES]),
  );
}

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
      .where(workspaceGithubConnectionFilter(scope))
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

/**
 * Make `installationId` the installation this workspace acts through, and
 * answer the connection it now hangs off.
 *
 * The caller has already established that the person asking can reach this
 * installation on GitHub. Nothing below re-checks it, so this must not be
 * called from anywhere that has not — the token the repository capabilities
 * mint through an attached installation is minted with the platform App's
 * private key and carries no caller entitlement at all.
 *
 * Merge, never replace: a connection the legacy sources wizard configured
 * carries operational keys (owner/repo/defaultBranch, syncDepthDays) the
 * resync path reads. Status is left alone on an update, because a workspace
 * that has already bound a repository is `connected` and choosing an
 * installation again is not a reason to demote it.
 *
 * A workspace with no live GitHub connection gets one, at `pending_setup`
 * rather than `connected`: `status = 'connected'` is precisely what the
 * ingestion poll scheduler claims, so marking it connected here would enrol a
 * workspace with no record-type mappings into the sync loop.
 * `bind_main_repository` promotes it when it binds a repository, and all the
 * repository reads match on the installation id rather than the status.
 *
 * The row it writes is the row {@link resolveWorkspaceGithubInstallation}
 * reads, because both go through {@link workspaceGithubConnectionFilter} and
 * both order newest-first. That is not a coincidence to be maintained by
 * attention; it is why the predicate is a function.
 */
export async function attachWorkspaceGithubInstallation(args: {
  orgId: string;
  workspaceId: string;
  installationId: string;
  /** The user this attach is attributed to (ADR-077); null when there is none. */
  actingUserId: string | null;
}): Promise<{ connectionId: string; publicId: string }> {
  const { orgId, workspaceId, installationId, actingUserId } = args;
  const now = new Date();

  return withTenantDb(async (tx) => {
    const existing = await tx
      .select({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(workspaceGithubConnectionFilter({ orgId, workspaceId }))
      .orderBy(desc(schema.sourceConnections.createdAt))
      .limit(1);

    const row = existing[0];
    if (row) {
      await tx
        .update(schema.sourceConnections)
        .set({
          deliveryConfig: {
            ...((row.deliveryConfig as Record<string, unknown> | null) ?? {}),
            installationId,
          },
          updatedAt: now,
          ...(actingUserId ? { updatedById: actingUserId } : {}),
        })
        .where(eq(schema.sourceConnections.id, row.id));
      return { connectionId: row.id, publicId: row.publicId };
    }

    const inserted = await tx
      .insert(schema.sourceConnections)
      .values({
        orgId,
        workspaceId,
        connectorId: GITHUB_PROVIDER,
        displayName: "GitHub",
        // The pair `connection.create` records for a github connection: the
        // App runs the authorization-code grant, and the connector declares
        // webhook delivery (packages/ingestion/src/connectors/github).
        authScheme: "oauth2_authorization_code",
        deliveryMethod: "webhook",
        deliveryConfig: { installationId },
        status: "pending_setup",
        createdAt: now,
        updatedAt: now,
        ...(actingUserId ? { createdById: actingUserId } : {}),
      })
      .returning({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
      });

    const created = inserted[0];
    if (!created) {
      throw new Error(
        "attachWorkspaceGithubInstallation: insert returned no row",
      );
    }
    return { connectionId: created.id, publicId: created.publicId };
  });
}
