// get_run_work's pull requests come from the forge store (ADR-292): the run's
// change set and the pull requests a receipt, a link frame, or a checkout's
// branch names, with patches from the stored diff and closing issues from
// the issue links. Checks are the one live GitHub read. These tests hand the
// read a fake forge store and a fake GitHub that can only list checks.
import { describe, expect, it, vi } from "vitest";
import type { RunCheckout } from "@oxagen/oxagen/contracts/run.work.get";
import { sha256Hex } from "@oxagen/storage/s3";
import { event } from "../run.test-support";
import type {
  RunPullRequest,
  RunPullRequestRead,
} from "./forge-pull-requests/run-pulls";
import {
  readLedgerPrReceipts,
  readWorkPullRequests,
  type WorkPrDeps,
} from "./run-work-prs";
import type { UnlinkedRepositoryResolver } from "./run-pr-link-repository";

const HEAD = "a".repeat(40);
const OLD_HEAD = "c".repeat(40);
const scope = { orgId: "org", workspaceId: "workspace" };
const repo = {
  host: "github.com",
  owner: "Acme",
  name: "Repo",
  url: "https://github.com/Acme/Repo",
  connected: true,
  connectionId: "verified-connection",
  providerRepositoryId: "R_1",
};
const checkout: RunCheckout = {
  id: "checkout",
  path: "/repo",
  branch: "fix/work",
  headSha: HEAD,
  remoteDigest: null,
  repository: {
    host: repo.host,
    owner: repo.owner,
    name: repo.name,
    url: repo.url,
    connected: true,
  },
  firstSeq: "1",
  lastSeq: "9",
};

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "",
].join("\n");
const BYTES = new TextEncoder().encode(DIFF);

type Pull = RunPullRequest["pull"];
type Revision = NonNullable<RunPullRequest["revision"]>;
type Issue = RunPullRequest["issues"][number];

function pull(over: Partial<Pull> = {}): Pull {
  return {
    id: "pull-1",
    publicId: "fpr_1",
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    provider: "github",
    host: "github.com",
    providerRepositoryId: "R_1",
    repository: "acme/repo",
    number: 2,
    url: "https://github.com/acme/repo/pull/2",
    title: "Recorded work",
    authorLogin: "dev",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: "fix/work",
    headSha: HEAD,
    baseSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    sourceUpdatedAt: null,
    stateSeenAt: new Date("2026-10-03T10:00:00Z"),
    createdAt: new Date("2026-10-03T10:00:00Z"),
    updatedAt: new Date("2026-10-03T10:00:00Z"),
    ...over,
  } as Pull;
}

function revision(over: Partial<Revision> = {}): Revision {
  return {
    id: "rev-1",
    publicId: "prv_1",
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    pullRequestId: "pull-1",
    headSha: HEAD,
    baseSha: null,
    mergeBaseSha: "b".repeat(40),
    diffStatus: "stored",
    diffStore: "s3",
    diffKey: "pr-diffs/org/workspace/github/R_1/2/head.diff",
    diffSha256: sha256Hex(BYTES),
    diffBytes: BYTES.byteLength,
    filesChanged: 2,
    additions: 2,
    deletions: 1,
    files: [
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
      { path: "img.png", status: "modified", additions: 0, deletions: 0 },
    ],
    complete: true,
    limitations: [],
    capturedAt: new Date("2026-10-03T10:00:00Z"),
    createdAt: new Date("2026-10-03T10:00:00Z"),
    ...over,
  } as Revision;
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "link-1",
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    pullRequestId: "pull-1",
    issueNodeId: "I_7",
    repository: "acme/repo",
    number: 7,
    url: "https://github.com/acme/repo/issues/7",
    title: "Checkout fails on retry",
    state: "open",
    linkedAt: new Date("2026-10-03T10:00:00Z"),
    ...over,
  } as Issue;
}

function entry(over: Partial<RunPullRequest> = {}): RunPullRequest {
  return {
    pull: pull(),
    revision: revision(),
    sources: ["run"],
    issues: [issue()],
    ...over,
  };
}

const CHECKS = {
  sha: HEAD,
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
};

function setup(read: Partial<RunPullRequestRead> = {}, bytes: Uint8Array | null = BYTES) {
  const github = { listCiChecks: vi.fn().mockResolvedValue(CHECKS) };
  const store = {
    name: "s3" as const,
    bucket: "diffs",
    putOnce: vi.fn(),
    get: vi.fn().mockResolvedValue(bytes),
  };
  const deps = {
    forge: vi.fn<WorkPrDeps["forge"]>().mockResolvedValue({
      pullRequests: [entry()],
      unstored: 0,
      trunks: [],
      ...read,
    }),
    store: vi.fn<WorkPrDeps["store"]>(() => store),
    client: vi.fn<WorkPrDeps["client"]>().mockResolvedValue(github),
  } satisfies WorkPrDeps;
  return { deps, github, store };
}

const RUN = "tse_4q8r1t6v3x5z0b2d7h2k9m";

describe("run pull requests from the forge store", () => {
  it("lists the run's pull request with its stored patches, closing issues, and live checks", async () => {
    const { deps, github, store } = setup();
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [checkout] },
      [repo],
      deps,
    );
    expect(store.get).toHaveBeenCalledWith(revision().diffKey);
    // Checks are read at the stored head, through the repository's own casing.
    expect(github.listCiChecks).toHaveBeenCalledWith({
      owner: "Acme",
      repo: "Repo",
      ref: HEAD,
    });
    expect(out.pullRequests).toEqual([
      {
        repository: {
          host: "github.com",
          owner: "Acme",
          name: "Repo",
          url: "https://github.com/Acme/Repo",
          connected: true,
        },
        number: 2,
        title: "Recorded work",
        url: "https://github.com/acme/repo/pull/2",
        state: "open",
        headSha: HEAD,
        headRef: "fix/work",
        baseRef: "main",
        association: "recorded",
        closingIssues: {
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
        },
        checkoutIds: ["checkout"],
        observedAt: "2026-10-03T10:00:00.000Z",
        current: true,
        ci: expect.objectContaining({ overall: "failing", complete: true }),
        diff: {
          digest: `sha256:${sha256Hex(BYTES)}`,
          headSha: HEAD,
          files: [
            {
              path: "src/a.ts",
              previousPath: null,
              status: "modified",
              additions: 2,
              deletions: 1,
              patch: "@@ -1 +1,2 @@\n-old\n+new\n+more",
            },
            {
              path: "img.png",
              previousPath: null,
              status: "modified",
              additions: 0,
              deletions: 0,
              patch: null,
            },
          ],
          complete: false,
          limitations: ["patch_not_available"],
        },
      },
    ]);
    expect(out.warnings).toEqual([]);
    expect(out.complete).toBe(true);
  });

  it("asks the forge store, never GitHub, which pull requests the run has", async () => {
    const { deps } = setup({ pullRequests: [] });
    await readWorkPullRequests(
      scope,
      {
        runId: RUN,
        checkouts: [checkout, { ...checkout, id: "again" }],
        receipts: [{ repositoryId: "R_1", number: 41, headSha: null }],
        links: [{ owner: "Acme", name: "Repo", number: 42 }],
      },
      [repo],
      deps,
    );
    expect(deps.forge).toHaveBeenCalledWith(scope, {
      runId: RUN,
      receipts: [{ providerRepositoryId: "R_1", number: 41 }],
      links: [{ provider: "github", repository: "acme/repo", number: 42 }],
      branches: [{ provider: "github", repository: "acme/repo", branch: "fix/work" }],
    });
    expect(deps.client).not.toHaveBeenCalled();
  });

  it("reads a GitLab merge request from the store, with no checks and no closing issues", async () => {
    const mr = pull({
      provider: "gitlab",
      host: "gitlab.com",
      providerRepositoryId: "991",
      repository: "acme/platform/web",
      number: 12,
      url: "https://gitlab.com/acme/platform/web/-/merge_requests/12",
    });
    const { deps, github } = setup({
      pullRequests: [
        entry({
          pull: mr,
          revision: revision({
            files: [
              { path: "src/a.ts", status: "modified", additions: null, deletions: null },
              { path: "img.png", status: "modified", additions: null, deletions: null },
            ],
          }),
          issues: [],
        }),
      ],
    });
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [repo],
      deps,
    );
    expect(github.listCiChecks).not.toHaveBeenCalled();
    expect(out.pullRequests[0]).toMatchObject({
      repository: {
        host: "gitlab.com",
        owner: "acme/platform",
        name: "web",
        url: "https://gitlab.com/acme/platform/web",
        connected: false,
      },
      number: 12,
      association: "recorded",
      closingIssues: null,
      ci: null,
      current: true,
      diff: {
        files: [
          expect.objectContaining({
            path: "src/a.ts",
            additions: null,
            deletions: null,
            patch: "@@ -1 +1,2 @@\n-old\n+new\n+more",
          }),
          expect.objectContaining({ path: "img.png", patch: null }),
        ],
      },
    });
    expect(out.warnings).toEqual(["gitlab_checks_not_read"]);
  });

  it("answers an unconfigured revision's file list with no patches, and says why (negative)", async () => {
    const { deps, store } = setup({
      pullRequests: [
        entry({
          revision: revision({
            diffStatus: "unconfigured",
            diffStore: null,
            diffKey: null,
            diffSha256: null,
            diffBytes: null,
            complete: false,
          }),
        }),
      ],
    });
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [checkout] },
      [repo],
      deps,
    );
    expect(store.get).not.toHaveBeenCalled();
    const diff = out.pullRequests[0]?.diff;
    expect(diff?.files.map((file) => [file.path, file.patch])).toEqual([
      ["src/a.ts", null],
      ["img.png", null],
    ]);
    expect(diff?.limitations).toEqual(["diff_unconfigured"]);
    expect(diff?.complete).toBe(false);
    expect(diff?.digest).toMatch(/^sha256:/);
    // The pull request itself still reads from the store.
    expect(out.pullRequests[0]).toMatchObject({ state: "open", headSha: HEAD });
  });

  it("keeps the file list and names the failure when the stored bytes do not match their digest (negative)", async () => {
    const { deps } = setup({}, new TextEncoder().encode("tampered"));
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [repo],
      deps,
    );
    const diff = out.pullRequests[0]?.diff;
    expect(diff?.files.every((file) => file.patch === null)).toBe(true);
    expect(diff?.limitations).toContain("diff_digest_mismatch");
    expect(out.warnings).toContain("diff_read_failed");
  });

  it("reads no bytes for a stored diff over the fetch cap (negative)", async () => {
    const { deps, store } = setup({
      pullRequests: [entry({ revision: revision({ diffBytes: 3 * 1024 * 1024 }) })],
    });
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [repo],
      deps,
    );
    expect(store.get).not.toHaveBeenCalled();
    expect(out.pullRequests[0]?.diff?.limitations).toEqual(["diff_size_limit"]);
  });

  it("marks a pull request only a checkout's branch reached, and its head match", async () => {
    const { deps } = setup({
      pullRequests: [
        entry({ sources: ["branch"] }),
        entry({
          pull: pull({ id: "pull-2", number: 3, headSha: OLD_HEAD }),
          revision: revision({ headSha: OLD_HEAD }),
          sources: ["branch"],
          issues: [],
        }),
      ],
    });
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [checkout] },
      [repo],
      deps,
    );
    expect(out.pullRequests.map((pr) => [pr.number, pr.association])).toEqual([
      [2, "head_commit"],
      [3, "branch"],
    ]);
  });

  it("names a checkout on a detached head or a trunk, which links nothing (negative)", async () => {
    const { deps } = setup({ pullRequests: [], trunks: ["github:acme/repo:main"] });
    const out = await readWorkPullRequests(
      scope,
      {
        runId: RUN,
        checkouts: [
          { ...checkout, id: "detached", branch: "HEAD" },
          { ...checkout, id: "trunk", branch: "main" },
        ],
      },
      [repo],
      deps,
    );
    expect(deps.forge.mock.calls[0]?.[1].branches).toEqual([
      { provider: "github", repository: "acme/repo", branch: "main" },
    ]);
    expect(out.warnings).toEqual(["default_branch_not_linked"]);
  });

  it("says when a receipt names a pull request the store lacks, and when the list was cut (negative)", async () => {
    const many = Array.from({ length: 21 }, (_, n) =>
      entry({ pull: pull({ id: `pull-${String(n)}`, number: n + 1 }), issues: [] }),
    );
    const { deps } = setup({ pullRequests: many, unstored: 1 });
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [repo],
      deps,
    );
    expect(out.pullRequests).toHaveLength(20);
    expect(out.warnings).toEqual(
      expect.arrayContaining(["pull_request_not_stored", "pull_request_limit"]),
    );
    expect(out.complete).toBe(false);
  });

  it("marks a pull request whose latest head has no revision yet as not current (negative)", async () => {
    const { deps } = setup({
      pullRequests: [
        entry({ revision: revision({ headSha: OLD_HEAD }) }),
        entry({ pull: pull({ id: "pull-2", number: 3 }), revision: null, issues: [] }),
      ],
    });
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [repo],
      deps,
    );
    expect(out.pullRequests[0]).toMatchObject({
      current: false,
      diff: { headSha: OLD_HEAD },
    });
    expect(out.pullRequests[1]).toMatchObject({
      current: false,
      diff: null,
      closingIssues: null,
    });
    expect(out.warnings).toEqual(
      expect.arrayContaining([
        "pull_request_head_not_captured",
        "pull_request_revision_missing",
      ]),
    );
  });

  it("reads no checks for a repository the workspace does not connect, and keeps a failed read explicit (negative)", async () => {
    const unconnected = setup();
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [],
      unconnected.deps,
    );
    expect(unconnected.deps.client).not.toHaveBeenCalled();
    expect(out.pullRequests[0]).toMatchObject({
      ci: null,
      repository: { owner: "acme", name: "repo", connected: false },
    });
    expect(out.warnings).toContain("repository_not_connected");

    const failing = setup();
    failing.github.listCiChecks.mockRejectedValue(new Error("GitHub 502"));
    const failed = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [repo],
      failing.deps,
    );
    expect(failed.pullRequests[0]?.ci).toBeNull();
    expect(failed.warnings).toContain("ci_read_failed");
  });

  it("is not current when GitHub answers checks for another head (negative)", async () => {
    const { deps, github } = setup();
    github.listCiChecks.mockResolvedValue({ ...CHECKS, sha: OLD_HEAD });
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [] },
      [repo],
      deps,
    );
    expect(out.pullRequests[0]?.current).toBe(false);
    expect(out.warnings).toContain("ci_head_mismatch");
  });
});

// #5296: a run's pull request in a repository the workspace does not link
// lists from the forge store like any other. Its checks are read through the
// workspace's own GitHub connection for the repository's owner.
describe("run pull requests in a repository the workspace does not link", () => {
  const owners = {
    host: "github.com",
    owner: "acme",
    name: "repo",
    url: "https://github.com/acme/repo",
    connected: false,
    connectionId: "owner-connection",
  };

  it("reads the checks through the owner's connection", async () => {
    const { deps, github } = setup();
    const unlinked = vi
      .fn<UnlinkedRepositoryResolver>()
      .mockResolvedValue(owners);
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [], unlinked },
      [],
      deps,
    );
    expect(unlinked).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        name: "repo",
        url: "https://github.com/acme/repo",
      }),
    );
    expect(deps.client).toHaveBeenCalledWith(scope, owners);
    expect(github.listCiChecks).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      ref: HEAD,
    });
    expect(out.pullRequests[0]).toMatchObject({
      repository: { owner: "acme", name: "repo", connected: false },
      association: "recorded",
      ci: { overall: "failing", complete: true },
    });
    expect(out.warnings).not.toContain("repository_not_connected");
  });

  it("lists the pull request with no checks when no connection reaches the owner (negative)", async () => {
    const { deps } = setup();
    const out = await readWorkPullRequests(
      scope,
      {
        runId: RUN,
        checkouts: [],
        unlinked: vi
          .fn<UnlinkedRepositoryResolver>()
          .mockResolvedValue("not_connected"),
      },
      [],
      deps,
    );
    expect(deps.client).not.toHaveBeenCalled();
    expect(out.pullRequests[0]).toMatchObject({
      ci: null,
      repository: { connected: false },
    });
    expect(out.warnings).toContain("repository_not_connected");
  });

  it("names a failed connection lookup as a failed checks read (negative)", async () => {
    const { deps } = setup();
    const out = await readWorkPullRequests(
      scope,
      {
        runId: RUN,
        checkouts: [],
        unlinked: vi
          .fn<UnlinkedRepositoryResolver>()
          .mockResolvedValue("lookup_failed"),
      },
      [],
      deps,
    );
    expect(deps.client).not.toHaveBeenCalled();
    expect(out.pullRequests[0]?.ci).toBeNull();
    expect(out.warnings).toContain("ci_read_failed");
    expect(out.warnings).not.toContain("repository_not_connected");
  });

  it("never asks a GitHub connection about a GitLab merge request (negative)", async () => {
    const { deps } = setup({
      pullRequests: [
        entry({
          pull: pull({
            provider: "gitlab",
            host: "gitlab.com",
            repository: "acme/repo",
            url: "https://gitlab.com/acme/repo/-/merge_requests/2",
          }),
        }),
      ],
    });
    const unlinked = vi.fn<UnlinkedRepositoryResolver>();
    const out = await readWorkPullRequests(
      scope,
      { runId: RUN, checkouts: [], unlinked },
      [],
      deps,
    );
    expect(unlinked).not.toHaveBeenCalled();
    expect(out.warnings).toContain("gitlab_checks_not_read");
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
