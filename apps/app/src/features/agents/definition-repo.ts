// The repository a definition was committed to, read from the pull request
// URL the commit recorded. `get_agent` carries the branch and the pull request
// and not the repository, and a GitHub pull request URL names both.

/** `owner/repo` from a GitHub pull request URL the commit recorded, or null. */
export function repositoryOf(pullRequestUrl: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(
    pullRequestUrl,
  );
  return match === null ? null : `${match[1]}/${match[2]}`;
}
