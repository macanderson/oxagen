import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoBranchCreate } from "@oxagen/oxagen/contracts/repo.branch.create";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";

export const repoBranchCreateHandler: CapabilityHandler<typeof repoBranchCreate> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });
  const result = await gh.createBranch({
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    fromBranch: input.fromBranch,
  });
  return {
    ref: result.ref,
    sha: result.sha,
  };
};
