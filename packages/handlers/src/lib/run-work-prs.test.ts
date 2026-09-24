import { describe, expect, it, vi } from "vitest";
import type { RunCheckout } from "@oxagen/oxagen/contracts/run.work.get";
import { readWorkPullRequests, type WorkPrDeps } from "./run-work-prs";
const repo = {
  host: "github.com",
  owner: "acme",
  name: "repo",
  url: "https://github.com/acme/repo",
  connected: true,
  connectionId: "verified-connection",
};
const checkout: RunCheckout = {
  id: "checkout",
  path: "/repo",
  branch: "fix/work",
  headSha: "head",
  remoteDigest: null,
  repository: repo,
  firstSeq: "1",
  lastSeq: "9",
};
const scope = { orgId: "org", workspaceId: "workspace" };
function setup(moving = false) {
  let reads = 0;
  const client = {
    getRepoInfo: vi.fn().mockResolvedValue({ defaultBranch: "main" }),
    listPullRequests: vi
      .fn()
      .mockResolvedValue([{ number: 2, htmlUrl: `${repo.url}/pull/2` }]),
    getPullRequest: vi.fn().mockImplementation(async () => ({
      number: 2,
      title: "Recorded work",
      htmlUrl: `${repo.url}/pull/2`,
      state: "open",
      merged: false,
      headSha: moving && reads++ > 0 ? "new-head" : "head",
      headRef: "fix/work",
      changedFiles: 1,
    })),
    listClosingIssues: vi.fn().mockResolvedValue({
      issues: [
        {
          owner: "acme",
          repo: "repo",
          number: 7,
          title: "Checkout fails on retry",
          url: "https://github.com/acme/repo/issues/7",
          state: "open",
        },
      ],
      complete: true,
    }),
    listCiChecks: vi.fn().mockResolvedValue({
      sha: "head",
      complete: true,
      checkRuns: [
        {
          name: "tests",
          status: "completed",
          conclusion: "failure",
          detailsUrl: "https://github.com/check",
          startedAt: null,
          completedAt: null,
          appName: "Actions",
        },
      ],
      statuses: [],
    }),
    listPullRequestFiles: vi.fn().mockResolvedValue([
      {
        path: "src/a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "-old\n+new",
      },
    ]),
  };
  const deps: WorkPrDeps = {
    client: vi.fn().mockResolvedValue(client),
    now: () => "2026-09-23T00:00:00Z",
  };
  return { deps, client };
}
describe("run pull request evidence", () => {
  it("reads connected PRs with pinned CI and diff provenance", async () => {
    const { deps, client } = setup();
    const output = await readWorkPullRequests(scope, [checkout], [repo], deps);
    expect(client.listCiChecks).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      ref: "head",
    });
    expect(output.pullRequests[0]).toMatchObject({
      current: true,
      association: "head_commit",
      ci: { overall: "failing", complete: true },
      diff: { headSha: "head", complete: true },
    });
    expect(output.pullRequests[0]?.diff?.digest).toMatch(/^sha256:/);
  });
  it("rejects a mutable PR diff if its head moved while reading", async () => {
    const { deps } = setup(true);
    const result = await readWorkPullRequests(scope, [checkout], [repo], deps);
    expect(result.pullRequests[0]).toMatchObject({
      current: false,
      diff: null,
    });
    expect(result.warnings).toContain("pull_request_head_changed");
  });
  it("never fetches a recorded remote that lacks a workspace connection", async () => {
    const { deps } = setup();
    const result = await readWorkPullRequests(scope, [checkout], [], deps);
    expect(deps.client).not.toHaveBeenCalled();
    expect(result.warnings).toContain("repository_not_connected");
  });
  it("keeps unavailable patches and partial CI explicit", async () => {
    const { deps, client } = setup();
    client.listCiChecks.mockResolvedValue({
      sha: "head",
      complete: false,
      checkRuns: [],
      statuses: [],
    });
    client.listPullRequestFiles.mockResolvedValue([
      {
        path: "image.png",
        previousPath: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        patch: null,
      },
    ]);
    const result = await readWorkPullRequests(scope, [checkout], [repo], deps);
    expect(result.pullRequests[0]).toMatchObject({
      ci: { complete: false },
      diff: { complete: false, limitations: ["patch_not_available"] },
    });
  });

  it("links no PR to a checkout on the default branch or a detached HEAD", async () => {
    for (const branch of ["main", "HEAD"]) {
      const { deps, client } = setup();
      const output = await readWorkPullRequests(
        scope,
        [{ ...checkout, branch }],
        [repo],
        deps,
      );
      expect(client.listPullRequests).not.toHaveBeenCalled();
      expect(output.pullRequests).toEqual([]);
      expect(output.warnings).toContain("default_branch_not_linked");
    }
  });
  // Issue #4024: a run's task comes from what its PR closes, as GitHub
  // records it, never from the branch name.
  it("carries the issues a pull request closes, from GitHub's own record", async () => {
    const { deps, client } = setup();
    const output = await readWorkPullRequests(scope, [checkout], [repo], deps);
    expect(client.listClosingIssues).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      number: 2,
    });
    expect(output.pullRequests[0]?.closingIssues).toEqual({
      issues: [
        {
          owner: "acme",
          repo: "repo",
          number: 7,
          title: "Checkout fails on retry",
          url: "https://github.com/acme/repo/issues/7",
          state: "open",
        },
      ],
      complete: true,
    });
    expect(output.warnings).not.toContain("closing_issues_read_failed");
  });
  it("reports an unread closing-issue list as unread, not as closing nothing", async () => {
    const { deps, client } = setup();
    client.listClosingIssues.mockRejectedValue(new Error("graphql refused"));
    const output = await readWorkPullRequests(scope, [checkout], [repo], deps);
    expect(output.pullRequests[0]?.closingIssues).toBeNull();
    expect(output.pullRequests[0]?.ci).not.toBeNull();
    expect(output.warnings).toContain("closing_issues_read_failed");
    expect(output.complete).toBe(false);
  });
});
