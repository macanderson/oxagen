/**
 * The repository a host's `control.interject` asked about, by name (#3941).
 *
 * The host never sends its remote in the clear (`collector/git-facts.ts`).
 * The frame carries `remote_digest`, the sha256 of `canonicalRemote(origin)`,
 * and on a case-insensitive forge `remote_digest_folded` too. Linking the
 * repository or creating a workspace for it needs `owner/name`, so the
 * control plane digests each repository the workspace's GitHub installation
 * can see, the way the host digests its remote and the way the bundle
 * digests a bound repository (`lib/tacho-unbound-repo.ts`), and takes the one
 * that matches.
 *
 * The installation is the run's workspace's, the one `link_repository`
 * reads through. A repository only another installation of the organisation
 * can see is not found here, and the answer then refuses both paths as
 * `interjection_repository_unresolved`.
 */
import { canonicalRemote, digestBytes, foldedRemote } from "@oxagen/tacho";
import type { GitHubInstallationRepositories } from "@oxagen/github";
import { logger } from "../logger";
import { resolveWorkspaceGithubInstallation } from "../repository.github-connection";
import { githubInstallationRepositoriesDeps } from "../repository.installation.list";

/** The organisation and workspace the run belongs to. */
export interface InterjectionRepositoryScope {
  orgId: string;
  workspaceId: string;
}

/** The digests a `control.interject` body carries. */
export interface InterjectionRemoteDigests {
  remote_digest: string;
  remote_digest_folded?: string | undefined;
}

/** The reads the resolution makes; injectable so a test can answer them. */
export interface InterjectionRepositoryDeps {
  /** The workspace's GitHub installation id, or null when it has none. */
  installation(scope: InterjectionRepositoryScope): Promise<string | null>;
  /** What the installation can reach, and whether the walk stopped short. */
  repositories(installationId: string): Promise<GitHubInstallationRepositories>;
}

export const GITHUB_INTERJECTION_REPOSITORY_DEPS: InterjectionRepositoryDeps = {
  installation: async (scope) =>
    (await resolveWorkspaceGithubInstallation(scope))?.installationId ?? null,
  repositories: (installationId) =>
    githubInstallationRepositoriesDeps.repositories(installationId),
};

/**
 * The digests a host would compute for `github.com/<fullName>`: the
 * canonical form and the folded one.
 */
export function repositoryDigests(fullName: string): string[] {
  const canonical = canonicalRemote(`github.com/${fullName}`);
  return [digestBytes(canonical), digestBytes(foldedRemote(canonical))];
}

/**
 * The first of `fullNames` whose digests hold either digest the frame
 * carries, or null. The host matches the same way against the bundle's
 * `bound_remote_digests`, which holds both forms of each bound repository.
 */
export function matchRepository(
  fullNames: readonly string[],
  remote: InterjectionRemoteDigests,
): string | null {
  const wanted = new Set(
    [remote.remote_digest, remote.remote_digest_folded].filter(
      (digest): digest is string => digest !== undefined,
    ),
  );
  for (const fullName of fullNames)
    if (repositoryDigests(fullName).some((digest) => wanted.has(digest)))
      return fullName;
  return null;
}

/**
 * `owner/name` of the repository the frame asked about, or null when the
 * workspace has no GitHub installation or the installation reaches no
 * repository with a matching digest. A GitHub failure is thrown.
 */
export async function resolveInterjectionRepository(
  scope: InterjectionRepositoryScope,
  remote: InterjectionRemoteDigests,
  deps: InterjectionRepositoryDeps = GITHUB_INTERJECTION_REPOSITORY_DEPS,
): Promise<string | null> {
  const installationId = await deps.installation(scope);
  if (installationId === null) return null;
  const { repositories, truncated } = await deps.repositories(installationId);
  const match = matchRepository(
    repositories.map((repository) => repository.fullName),
    remote,
  );
  if (match === null)
    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        repositories: repositories.length,
        truncated,
      },
      "interjection: no repository the workspace's installation reaches matches the frame's remote digest",
    );
  return match;
}
