import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoBranchList } from "@oxagen/oxagen/contracts/repo.branch.list";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";

export const repoBranchListHandler: CapabilityHandler<
  typeof repoBranchList
> = async (input, ctx) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });

  // The default branch is supplementary metadata used only to flag
  // `isDefault` — resolve it best-effort so a repo-info hiccup doesn't fail
  // the whole listing.
  const [branches, defaultBranch] = await Promise.all([
    gh.listBranches({ owner: input.owner, repo: input.repo }),
    gh
      .getRepoInfo({ owner: input.owner, repo: input.repo })
      .then((info) => info.defaultBranch)
      .catch(() => null),
  ]);

  return {
    branches: branches.map((b) => ({
      name: b.name,
      sha: b.sha,
      isDefault: defaultBranch !== null && b.name === defaultBranch,
      protected: b.protected,
    })),
    defaultBranch,
  };
};
