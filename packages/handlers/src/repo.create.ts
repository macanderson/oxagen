import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoCreate } from "@oxagen/oxagen/contracts/repo.create";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";

export const repoCreateHandler: CapabilityHandler<typeof repoCreate> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });
  const result = await gh.createRepoInOrg({
    org: input.org,
    name: input.name,
    description: input.description,
    private: input.private,
    autoInit: input.autoInit,
  });
  return {
    fullName: result.fullName,
    htmlUrl: result.htmlUrl,
    defaultBranch: result.defaultBranch,
  };
};
