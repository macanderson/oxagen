import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoFork } from "@oxagen/oxagen/contracts/repo.fork";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";

export const repoForkHandler: CapabilityHandler<typeof repoFork> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });
  const result = await gh.forkRepo({
    owner: input.owner,
    repo: input.repo,
    org: input.intoOrg,
  });
  return {
    fullName: result.fullName,
    htmlUrl: result.htmlUrl,
    defaultBranch: result.defaultBranch,
  };
};
