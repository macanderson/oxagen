import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoPrGet } from "@oxagen/oxagen/contracts/repo.pr.get";
import type { RepoPrGetOutput } from "@oxagen/oxagen/contracts/repo.pr.get";
import { createGitHubClient } from "@oxagen/github";
import type { GitHubCiChecks } from "@oxagen/github";
import { resolveGitHubToken } from "./lib/github-token";
import { buildCiSummary } from "./lib/ci-status";

const COMMENT_CAP = 50;

type PrComment = RepoPrGetOutput["comments"][number];

export const repoPrGetHandler: CapabilityHandler<typeof repoPrGet> = async (
  input,
  ctx,
) => {
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });

  const pr = await gh.getPullRequest({
    owner: input.owner,
    repo: input.repo,
    number: input.number,
  });

  // Comments and CI are best-effort — fetch in parallel with the PR already in
  // hand. CI needs the head SHA, so only fetch when we have one.
  const [comments, checks] = await Promise.all([
    gh.listPullRequestComments({
      owner: input.owner,
      repo: input.repo,
      number: input.number,
    }),
    pr.headSha
      ? gh.listCiChecks({
          owner: input.owner,
          repo: input.repo,
          ref: pr.headSha,
        })
      : Promise.resolve<GitHubCiChecks>({
          sha: null,
          checkRuns: [],
          statuses: [],
        }),
  ]);

  // Merge both comment streams, newest first, capped. commentCount /
  // reviewCommentCount come from the PR object's true totals, not this list.
  const merged: PrComment[] = [
    ...comments.issue.map<PrComment>((c) => ({
      id: c.id,
      author: c.authorLogin,
      authorAvatarUrl: c.authorAvatarUrl,
      body: c.body,
      createdAt: c.createdAt,
      url: c.htmlUrl,
      kind: "issue",
      path: null,
    })),
    ...comments.review.map<PrComment>((c) => ({
      id: c.id,
      author: c.authorLogin,
      authorAvatarUrl: c.authorAvatarUrl,
      body: c.body,
      createdAt: c.createdAt,
      url: c.htmlUrl,
      kind: "review",
      path: c.path,
    })),
  ]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, COMMENT_CAP);

  const { overall, counts, runs } = buildCiSummary(checks);

  const state: RepoPrGetOutput["state"] = pr.merged
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : "open";

  return {
    number: pr.number,
    title: pr.title,
    url: pr.htmlUrl,
    state,
    draft: pr.draft,
    author: pr.authorLogin,
    authorAvatarUrl: pr.authorAvatarUrl,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    body: pr.body,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    headSha: pr.headSha,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commits: pr.commits,
    commentCount: pr.commentCount,
    reviewCommentCount: pr.reviewCommentCount,
    comments: merged,
    ci: { overall, counts, runs },
  };
};
