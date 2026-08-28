import { HTTPException } from "hono/http-exception";

/**
 * Hard write invariant: Oxagen never writes directly to a
 * repository's default branch. Work lands on a dedicated branch and reaches
 * the default branch only through a pull request. Enforced here, at the
 * handler layer, so every surface (agent, api, mcp) inherits it — the
 * GitHub client itself stays policy-free.
 */
interface RepoInfoReader {
  getRepoInfo(args: {
    owner: string;
    repo: string;
  }): Promise<{ defaultBranch: string }>;
}

/**
 * Throws 403 when `branch` is omitted (GitHub would silently target the
 * default branch) or names the default branch. Returns the resolved default
 * branch name so callers can reuse it without a second API round-trip.
 */
export async function assertNonDefaultBranchWrite(
  gh: RepoInfoReader,
  args: {
    owner: string;
    repo: string;
    branch: string | undefined;
    capability: string;
  },
): Promise<string> {
  const { defaultBranch } = await gh.getRepoInfo({
    owner: args.owner,
    repo: args.repo,
  });

  if (!args.branch) {
    throw new HTTPException(403, {
      message:
        `${args.capability}: "branch" is required — omitting it would target the ` +
        `repository default branch ("${defaultBranch}"), which Oxagen never ` +
        `writes to. Create a work branch with create_branch and pass it explicitly.`,
    });
  }

  if (args.branch === defaultBranch) {
    throw new HTTPException(403, {
      message:
        `${args.capability} targeting the default branch ("${defaultBranch}") is ` +
        `blocked: Oxagen never writes directly to a repository's default branch. ` +
        `Use a work branch and land changes via open_pr.`,
    });
  }

  return defaultBranch;
}
