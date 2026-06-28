import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoFilePut } from "@oxagen/oxagen/contracts/repo.file.put";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";

export const repoFilePutHandler: CapabilityHandler<typeof repoFilePut> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });
  const result = await gh.putFile({
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    content: input.content,
    message: input.message,
    branch: input.branch,
  });
  return {
    commitSha: result.commitSha,
    htmlUrl: result.htmlUrl,
  };
};
