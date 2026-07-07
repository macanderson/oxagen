import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoPrDiff } from "@oxagen/oxagen/contracts/repo.pr.diff";
import type { RepoPrDiffOutput } from "@oxagen/oxagen/contracts/repo.pr.diff";
import { createGitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";

type DiffFile = RepoPrDiffOutput["files"][number];

export const repoPrDiffHandler: CapabilityHandler<typeof repoPrDiff> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });

  const rawFiles = await gh.listPullRequestFiles({
    owner: input.owner,
    repo: input.repo,
    number: input.number,
  });

  let additions = 0;
  let deletions = 0;

  const files: DiffFile[] = rawFiles.map((f) => {
    additions += f.additions;
    deletions += f.deletions;
    // GitHub omits `patch` for binary files (and truncates very large diffs).
    // A file with no patch but nonzero line changes is binary.
    const binary = f.patch === null && f.changes > 0;
    return {
      path: f.path,
      previousPath: f.previousPath,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      binary,
    };
  });

  const summary = `${files.length} file${files.length === 1 ? "" : "s"}, +${additions} -${deletions}`;

  return {
    summary,
    additions,
    deletions,
    changedFiles: files.length,
    files,
  };
};
