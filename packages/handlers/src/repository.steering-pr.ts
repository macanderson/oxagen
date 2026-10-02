// repository.steering-pr.ts: open the steering PR that changes which code
// repositories workspace.toml lists (ADR-212).
//
// The steps follow `set_governance_mode`. The branch comes from the
// production branch, the file lands on it, and only then does the handler
// look for an open PR, so a reused PR always carries this change. A second
// call for the same repository reuses the branch and the PR.
//
// With `record`, the PR's `workspace` proposal row is written or moved to the
// new head, so merge_context_pr can land it through the merge queue (#5122,
// ADR-264). A row that fails to write is logged, and the PR stays open.
import { createHash } from "node:crypto";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import type { SteeringPullRequest } from "@oxagen/oxagen/contracts/repository.link";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import {
  githubRefused,
  type SteeringHost,
  type SteeringRepository,
} from "./context.steering.github";
import {
  recordSteeringPrQuietly,
  type SteeringPrAuthor,
  type SteeringPrProposalStore,
} from "./steering-repo/pr-proposal";

export type SteeringPullRequestHost = Pick<
  SteeringHost,
  "ensureBranch" | "putFile" | "findOpenPullRequest" | "openPullRequest"
>;

/**
 * Put `content` at workspace.toml on `branch` and open, or reuse, the steering
 * PR from `branch` into the production branch.
 */
export async function openSteeringPullRequest(
  host: SteeringPullRequestHost,
  repo: SteeringRepository,
  args: {
    branch: string;
    content: string;
    message: string;
    title: string;
    body: string;
  },
  record?: {
    store: SteeringPrProposalStore;
    scope: { orgId: string; workspaceId: string };
    author: SteeringPrAuthor;
    now: Date;
  },
): Promise<SteeringPullRequest> {
  let pullRequest: SteeringPullRequest;
  let headSha: string;
  try {
    await host.ensureBranch(repo, args.branch, repo.defaultBranch);
    ({ commitSha: headSha } = await host.putFile(repo, {
      path: WORKSPACE_TOML_PATH,
      content: args.content,
      message: args.message,
      branch: args.branch,
    }));
    const open = await host.findOpenPullRequest(repo, {
      head: args.branch,
      base: repo.defaultBranch,
    });
    if (open) {
      pullRequest = { number: open.number, url: open.htmlUrl, reused: true };
    } else {
      const opened = await host.openPullRequest(repo, {
        title: args.title,
        head: args.branch,
        base: repo.defaultBranch,
        body: args.body,
        labels: OXAGEN_PR_LABELS,
      });
      pullRequest = { number: opened.number, url: opened.htmlUrl, reused: false };
    }
  } catch (err) {
    throw githubRefused(err);
  }
  if (record !== undefined) {
    await recordSteeringPrQuietly(
      record.store,
      {
        scope: record.scope,
        repo,
        kind: "workspace",
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
          branch: args.branch,
          headSha,
        },
        title: args.title,
        paths: [WORKSPACE_TOML_PATH],
        check: null,
        author: record.author,
      },
      record.now,
    );
  }
  return pullRequest;
}

/**
 * The branch a link or an unlink steering PR uses. A change to workspace.toml
 * takes the `workspace/` prefix. One branch per repository and direction, so
 * a second call reuses the first call's PR.
 *
 * The readable part cannot tell `acme-corp/docs` from `acme/corp-docs`, so
 * the branch ends with a hash of the exact reference. Two repositories that
 * share a branch would share a PR, and the second write would drop the first
 * repository's entry. The hash also keeps the name a ref git accepts: a name
 * ending in `.` or `.lock` no longer ends the branch, and runs of dots
 * collapse, because git refuses `..` in a ref.
 */
export function workspaceTomlBranch(
  action: "link" | "unlink",
  owner: string,
  name: string,
): string {
  const ref = `${owner}/${name}`.toLowerCase();
  const slug = `${owner}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".");
  const hash = createHash("sha256").update(ref).digest("hex").slice(0, 8);
  return `workspace/${action}-${slug}-${hash}`;
}
