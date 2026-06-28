import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoPrOpen } from "@oxagen/oxagen/contracts/repo.pr.open";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";

export const repoPrOpenHandler: CapabilityHandler<typeof repoPrOpen> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });
  const result = await gh.openPullRequest({
    owner: input.owner,
    repo: input.repo,
    title: input.title,
    head: input.head,
    base: input.base,
    body: input.body,
    draft: input.draft,
  });
  return {
    number: result.number,
    htmlUrl: result.htmlUrl,
  };
};
