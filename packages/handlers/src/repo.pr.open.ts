import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoPrOpen } from "@oxagen/oxagen/contracts/repo.pr.open";
import { createGitHubClient } from "@oxagen/github";
import { HTTPException } from "hono/http-exception";
import { resolveGitHubToken } from "./lib/github-token";

export const repoPrOpenHandler: CapabilityHandler<typeof repoPrOpen> = async (
  input,
  ctx,
) => {
  if (input.head === input.base) {
    throw new HTTPException(400, {
      message:
        `open_pr requires head and base to differ — received "${input.head}" ` +
        `for both. Commit to a work branch (create_branch + put_repo_file) ` +
        `and open the pull request from it.`,
    });
  }

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
