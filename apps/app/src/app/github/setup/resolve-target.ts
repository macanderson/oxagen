/**
 * Pure resolution logic for the GitHub App "Setup URL" landing route.
 *
 * Kept free of server-only / database imports so it is unit-testable in a plain
 * node environment. The page (`page.tsx`) supplies the two database-backed
 * queries via the {@link GithubSetupQueries} seam and turns the resolved path
 * into a `redirect()`.
 *
 * Behaviour (see page.tsx for the full GitHub-side context):
 *   - The same GitHub App installation can back connections in many tenants and
 *     workspaces — even the same repository across different tenants. When the
 *     redirect carries an `installation_id`, we land the user in the MOST
 *     RECENTLY installed workspace/tenant they have access to.
 *   - `matchInstallation` is responsible for the "most recent first" ordering
 *     (connection.updated_at DESC) AND the membership gate (only orgs the user
 *     belongs to). This resolver simply takes the first row it returns.
 *   - When there is no installation match (or no `installation_id` at all) we
 *     fall back to the user's most recently joined workspace so they still land
 *     somewhere useful rather than on a dead end.
 */

/** A resolved org/workspace pair. `workspaceSlug` is null when the org has no workspace yet. */
export type GithubSetupTargetRow = {
  orgSlug: string;
  workspaceSlug: string | null;
};

export type GithubSetupQueries = {
  /**
   * Source connections carrying this installation id that belong to an org the
   * user is a member of, ordered MOST RECENTLY INSTALLED FIRST. The query is the
   * security boundary — it must only ever return orgs/workspaces the user can
   * access. Row 0 is the target.
   */
  matchInstallation: (
    userId: string,
    installationId: string,
  ) => Promise<GithubSetupTargetRow[]>;
  /** The user's most recently joined org/workspace (the no-installation fallback). */
  mostRecentMembership: (userId: string) => Promise<GithubSetupTargetRow[]>;
};

/** Build the GitHub connections (Knowledge → Repos) URL for a workspace. */
export function buildSourcesPath(orgSlug: string, workspaceSlug: string): string {
  return `/${orgSlug}/${workspaceSlug}/knowledge/repos?setup=github`;
}

/**
 * Resolve the in-app path GitHub's Setup URL redirect should land on.
 *
 * @param userId          the signed-in user (membership gate is applied in the queries)
 * @param installationId  the GitHub App installation id from the redirect, if present
 * @param queries         database-backed lookups (injected for testability)
 */
export async function resolveGithubSetupTarget(
  userId: string,
  installationId: string | undefined,
  queries: GithubSetupQueries,
): Promise<string> {
  // 1. Most recently installed workspace for THIS installation the user can reach.
  if (installationId) {
    const matched = await queries.matchInstallation(userId, installationId);
    const hit = matched[0];
    if (hit?.workspaceSlug) {
      return buildSourcesPath(hit.orgSlug, hit.workspaceSlug);
    }
  }

  // 2. Fallback: the user's most recently joined workspace.
  const fallback = await queries.mostRecentMembership(userId);
  const first = fallback[0];
  if (!first) return "/new-organization";
  if (first.workspaceSlug) {
    return buildSourcesPath(first.orgSlug, first.workspaceSlug);
  }
  return `/${first.orgSlug}`;
}
