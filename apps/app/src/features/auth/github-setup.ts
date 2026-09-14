// GitHub App "Setup URL" landing (/github/setup), carried over from
// apps/app_deprecated/src/app/github/setup. GitHub redirects here after someone
// configures an existing installation; the redirect carries `installation_id`
// and `setup_action` but no signed state, so it cannot name a workspace. The
// person lands in the most recently installed workspace they are a member of,
// or, with no match, their most recently joined workspace's repositories.
//
// Routes follow spec Appendix F: `knowledge/sources` and `settings/github` are
// absorbed by Ontology (Sources and Repositories tabs).

export type GithubSetupTargetRow = {
  orgSlug: string;
  workspaceSlug: string | null;
};

export type GithubSetupQueries = {
  /** Connections carrying this installation in orgs the user belongs to, most recently installed first. */
  matchInstallation: (
    userId: string,
    installationId: string,
  ) => Promise<GithubSetupTargetRow[]>;
  /** The user's most recently joined org and one of its workspaces. */
  mostRecentMembership: (userId: string) => Promise<GithubSetupTargetRow[]>;
};

export const NO_ORGANIZATION_TARGET = "/welcome";

export function sourcesPath(orgSlug: string, workspaceSlug: string): string {
  return `/${orgSlug}/${workspaceSlug}/ontology/sources?setup=github`;
}

export function repositoriesPath(
  orgSlug: string,
  workspaceSlug: string,
): string {
  return `/${orgSlug}/${workspaceSlug}/ontology/repositories?github_installed=1`;
}

/** GitHub installation ids are positive integers; anything else is ignored rather than queried. */
export function parseInstallationId(
  raw: string | undefined,
): string | undefined {
  return raw !== undefined && /^[1-9]\d{0,19}$/.test(raw) ? raw : undefined;
}

export async function resolveGithubSetupTarget(
  userId: string,
  installationId: string | undefined,
  queries: GithubSetupQueries,
): Promise<string> {
  if (installationId) {
    const hit = (await queries.matchInstallation(userId, installationId))[0];
    if (hit?.workspaceSlug) return sourcesPath(hit.orgSlug, hit.workspaceSlug);
  }
  const first = (await queries.mostRecentMembership(userId))[0];
  if (!first) return NO_ORGANIZATION_TARGET;
  return first.workspaceSlug
    ? repositoriesPath(first.orgSlug, first.workspaceSlug)
    : `/${first.orgSlug}`;
}
