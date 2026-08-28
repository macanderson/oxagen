import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoFilePut } from "@oxagen/oxagen/contracts/repo.file.put";
import { createGitHubClient } from "@oxagen/github";
import { assertNonDefaultBranchWrite } from "./lib/default-branch-guard";
import { resolveGitHubToken } from "./lib/github-token";
import { diffFileContents } from "./lib/unified-diff";
import { logger } from "./logger";

export const repoFilePutHandler: CapabilityHandler<typeof repoFilePut> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });

  // Hard invariant: commits land on a work branch, never the
  // default branch — omitting `branch` would silently target it.
  await assertNonDefaultBranchWrite(gh, {
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    capability: "put_repo_file",
  });

  // Snapshot the file's current content on the target branch BEFORE
  // overwriting it (null when the file doesn't exist yet — a new-file
  // commit), so we can hand back a real unified diff alongside the commit
  // result. This is what lights up the code-diff card's full hunk view
  // instead of the path-only fallback row.
  const before = await gh
    .getFileContent({
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      ref: input.branch,
    })
    .catch((err: unknown) => {
      logger.error(
        { err, orgId: ctx.orgId, path: input.path },
        "repo.file.put: failed to read prior file content for diff computation",
      );
      return null;
    });

  const result = await gh.putFile({
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    content: input.content,
    message: input.message,
    branch: input.branch,
  });

  const diff = diffFileContents(input.path, before ?? "", input.content);

  return {
    commitSha: result.commitSha,
    htmlUrl: result.htmlUrl,
    diffs: [diff],
  };
};
