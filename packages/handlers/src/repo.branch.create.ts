import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoBranchCreate } from "@oxagen/oxagen/contracts/repo.branch.create";
import { createGitHubClient } from "@oxagen/github";
import { assertNonDefaultBranchWrite } from "./lib/default-branch-guard";
import { resolveGitHubToken } from "./lib/github-token";

export const repoBranchCreateHandler: CapabilityHandler<
  typeof repoBranchCreate
> = async (input, ctx) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });

  // Hard invariant: the new ref must not shadow the default
  // branch (defense-in-depth on top of GitHub's existing-ref rejection).
  await assertNonDefaultBranchWrite(gh, {
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    capability: "create_branch",
  });

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
