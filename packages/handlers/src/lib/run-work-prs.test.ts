import { describe, expect, it, vi } from "vitest";
import type { RunCheckout } from "@oxagen/oxagen/contracts/run.work.get";
import { event } from "../run.test-support";
import {
  readLedgerPrReceipts,
  readWorkPullRequests,
  type WorkPrDeps,
} from "./run-work-prs";
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
      baseRef: "main",
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
      headRef: "fix/work",
      baseRef: "main",
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

// #5296: a run that opened several pull requests showed none. The record
// named each one, and the read dropped every one it could not tie to a
// repository the workspace links.
describe("run pull requests the record names", () => {
  const linked = { ...repo, providerRepositoryId: "R_1" };
  type PrInput = { owner: string; repo: string; number: number };
  /** GitHub's answer for each number: 42 merged, 43 closed, the rest open. */
  function answering(client: ReturnType<typeof setup>["client"]) {
    client.getPullRequest.mockImplementation(async (input: PrInput) => ({
      number: input.number,
      title: `Change ${String(input.number)}`,
      htmlUrl: `https://github.com/${input.owner}/${input.repo}/pull/${String(input.number)}`,
      state: input.number === 43 ? "closed" : "open",
      merged: input.number === 42,
      headSha: "head",
      headRef: `fix/${String(input.number)}`,
      baseRef: "main",
      changedFiles: 1,
    }));
  }
  /** The pull requests read for linked receipts with these numbers. */
  async function listed(numbers: number[]) {
    const { deps, client } = setup();
    answering(client);
    const receipts = numbers.map((number) => ({
      repositoryId: "R_1",
      number,
      headSha: null,
    }));
    const output = await readWorkPullRequests(
      scope,
      [],
      [linked],
      deps,
      receipts,
    );
    return output.pullRequests.map((pr) => ({
      number: pr.number,
      state: pr.state,
      association: pr.association,
    }));
  }

  it("lists no pull request when the record names none", async () => {
    expect(await listed([])).toEqual([]);
  });

  it("lists the one pull request the record names, with its state", async () => {
    expect(await listed([41])).toEqual([
      { number: 41, state: "open", association: "recorded" },
    ]);
  });

  it("lists every pull request the record names, each with its state", async () => {
    expect(await listed([41, 42, 43])).toEqual([
      { number: 41, state: "open", association: "recorded" },
      { number: 42, state: "merged", association: "recorded" },
      { number: 43, state: "closed", association: "recorded" },
    ]);
  });

  it("reads an unlinked repository's receipt through the connection it carries", async () => {
    const { deps, client } = setup();
    answering(client);
    const unlinked = {
      host: "github.com",
      owner: "oxageninc",
      name: "product",
      url: "https://github.com/oxageninc/product",
      connected: false,
      connectionId: "owner-connection",
    };
    const output = await readWorkPullRequests(scope, [], [linked], deps, [
      { repository: unlinked, number: 41, headSha: null },
      { repository: unlinked, number: 42, headSha: null },
    ]);
    expect(deps.client).toHaveBeenCalledWith(scope, unlinked);
    expect(client.getPullRequest).toHaveBeenCalledWith({
      owner: "oxageninc",
      repo: "product",
      number: 42,
    });
    expect(output.pullRequests).toMatchObject([
      {
        number: 41,
        state: "open",
        association: "recorded",
        checkoutIds: [],
        repository: { owner: "oxageninc", name: "product", connected: false },
      },
      {
        number: 42,
        state: "merged",
        repository: { connected: false },
      },
    ]);
    expect(output.warnings).not.toContain("recorded_repository_not_connected");
  });

  it("still says a receipt names a repository it cannot read (negative)", async () => {
    const { deps } = setup();
    const output = await readWorkPullRequests(scope, [], [linked], deps, [
      { repositoryId: "R_unknown", number: 7, headSha: null },
    ]);
    expect(output.pullRequests).toEqual([]);
    expect(output.warnings).toEqual(["recorded_repository_not_connected"]);
    expect(deps.client).not.toHaveBeenCalled();
  });

  it("reads the recorded pull requests before 20 branches can spend every discovery", async () => {
    const { deps, client } = setup();
    answering(client);
    client.listPullRequests.mockResolvedValue([]);
    const branches = Array.from(
      { length: 20 },
      (_, n): RunCheckout => ({
        ...checkout,
        id: `checkout-${String(n)}`,
        branch: `fix/${String(n)}`,
      }),
    );
    const receipt = { repositoryId: "R_1", number: 41, headSha: null };
    const output = await readWorkPullRequests(
      scope,
      branches,
      [linked],
      deps,
      [receipt],
    );
    const read = output.pullRequests.map((pr) => [pr.number, pr.association]);
    expect(read).toEqual([[41, "recorded"]]);
  });
});

// get_run_work and get_run_issues read a ledger run's pull requests from the
// same events, so the walk is one function.
describe("readLedgerPrReceipts", () => {
  const opened = (runSeq: number, number: number) =>
    event(runSeq, {
      eventType: "provider_publish.pull_request_opened",
      payload: {
        provider_repository_id: "R_1",
        pull_request_number: number,
        head_commit_sha: "abc",
      },
    });

  it("reads each opened pull request, and skips other events and unreadable payloads", async () => {
    const store = {
      readAttemptEventsSince: vi.fn().mockResolvedValue([
        opened(1, 41),
        event(2),
        event(3, {
          eventType: "provider_publish.pull_request_opened",
          payload: { provider_repository_id: "R_1" },
        }),
        opened(4, 42),
      ]),
    };
    await expect(readLedgerPrReceipts(store, "run")).resolves.toEqual({
      receipts: [
        { repositoryId: "R_1", number: 41, headSha: "abc", seq: "1" },
        { repositoryId: "R_1", number: 42, headSha: "abc", seq: "4" },
      ],
      complete: true,
    });
    expect(store.readAttemptEventsSince).toHaveBeenCalledWith("run", "0", 500);
  });

  it("walks page by page from the last event, and says when it stopped at the bound", async () => {
    const page = (from: number) =>
      Array.from({ length: 500 }, (_, i) => event(from + i));
    const store = {
      readAttemptEventsSince: vi
        .fn()
        .mockImplementation(async (_run: string, cursor: string) =>
          page(Number(cursor) + 1),
        ),
    };
    const result = await readLedgerPrReceipts(store, "run");
    expect(result.complete).toBe(false);
    expect(store.readAttemptEventsSince).toHaveBeenCalledTimes(20);
    expect(store.readAttemptEventsSince.mock.calls[1]?.[1]).toBe("500");
  });
});
