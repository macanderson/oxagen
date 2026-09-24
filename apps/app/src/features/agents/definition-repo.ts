// The repository a definition was committed to, read from the pull request
// URL the commit recorded. `get_agent` carries the branch and the pull request
// and not the repository, and a GitHub pull request URL names both.

/** `owner/repo` from a GitHub pull request URL the commit recorded, or null. */
export function repositoryOf(pullRequestUrl: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(
    pullRequestUrl,
  );
  const owner = match?.[1];
  const repo = match?.[2];
  return owner === undefined || repo === undefined ? null : `${owner}/${repo}`;
}
