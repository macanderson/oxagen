import {
  type OutcomeRow,
  type OutcomeRun,
  prKeyOf,
  type RunPrCiState,
  type RunPrState,
  type TachoPrLink,
  withRevert,
} from "@oxagen/billing";
import { GitHubApiError, type GitHubClient } from "@oxagen/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { event } from "../run.test-support";
import {
  type ForgeOutcome,
  type ForgeOutcomeRead,
  type LedgerRunPr,
  type OutcomeRefreshDeps,
  readGithubOutcome,
  readLedgerRunPrs,
  refreshRunPrOutcomes,
} from "./run-pr-outcomes-refresh";

const mocks = vi.hoisted(() => ({
  connectedRunRepositories: vi.fn(),
}));

vi.mock("./run-work", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-work")>();
  return {
    ...actual,
    connectedRunRepositories: mocks.connectedRunRepositories,
  };
});
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const NOW = new Date("2026-09-27T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const run = (runId: string, runSource: "ledger" | "tacho" = "tacho"): OutcomeRun => ({
  runId,
  runSource,
  startedAt: hoursAgo(30),
  sealedAt: hoursAgo(29),
});

const link = (runId: string, number: number, over: Partial<TachoPrLink> = {}): TachoPrLink => ({
  runId,
  url: `https://github.com/acme/app/pull/${number}`,
  provider: "github",
  repository: "acme/app",
  number,
  state: "open",
  stateSeenAt: hoursAgo(28),
  sourceUpdatedAt: hoursAgo(28),
  ...over,
});

interface ForgeOpts {
  headSha?: string;
  headRef?: string;
  mergedAt?: Date;
  updatedAt?: Date;
  body?: string | null;
  ci?: RunPrCiState | null;
  branch?: boolean | null;
  mergeCommitSha?: string;
}

/** What a GitHub read of one pull request returns, read at NOW. */
function forge(state: RunPrState, opts: ForgeOpts = {}): ForgeOutcomeRead {
  const headSha = opts.headSha ?? "a".repeat(40);
  const merged = state === "merged";
  const mergedAt = merged ? (opts.mergedAt ?? hoursAgo(3)) : null;
  return {
    state: {
      state,
      readAt: NOW,
      closedAt: null,
      mergedAt,
      mergeCommitSha: merged ? (opts.mergeCommitSha ?? "c".repeat(40)) : null,
      baseRef: "main",
      headRef: opts.headRef ?? "feat/x",
      headSha,
      sourceUpdatedAt: opts.updatedAt ?? mergedAt ?? hoursAgo(3),
    },
    body: opts.body ?? null,
    ci:
      opts.ci === null
        ? null
        : { state: opts.ci ?? "passed", headSha, readAt: NOW },
    headBranch:
      opts.branch === null ? null : { exists: opts.branch ?? false, readAt: NOW },
  };
}

interface FakeInput {
  runs: OutcomeRun[];
  reasons?: Record<string, string | null>;
  links?: TachoPrLink[];
  ledger?: Record<string, LedgerRunPr[]>;
  forge?: Record<string, ForgeOutcome | Error>;
}

/** Dependencies over an in-memory table, which saves and marks as the store does. */
function fake(input: FakeInput) {
  const rows = new Map<string, OutcomeRow>();
  const reads: string[] = [];
  const saved: OutcomeRow[][] = [];
  const ledgerAsked: string[][] = [];
  const deps: OutcomeRefreshDeps = {
    now: () => NOW,
    listRuns: () => Promise.resolve(input.runs),
    terminalReasons: () =>
      Promise.resolve(new Map(Object.entries(input.reasons ?? {}))),
    readRows: (_scope, ids) =>
      Promise.resolve([...rows.values()].filter((r) => ids.includes(r.runId))),
    tachoLinks: (_scope, ids) =>
      Promise.resolve((input.links ?? []).filter((l) => ids.includes(l.runId))),
    ledgerPrs: (_scope, ids) => {
      ledgerAsked.push([...ids]);
      return Promise.resolve(
        new Map(
          Object.entries(input.ledger ?? {}).filter(([id]) => ids.includes(id)),
        ),
      );
    },
    readForge: (_scope, pr) => {
      const key = prKeyOf(pr.provider, pr.repository, pr.number);
      reads.push(key);
      const found = input.forge?.[key] ?? "unreadable";
      return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
    },
    saveRows: (_scope, next) => {
      saved.push([...next]);
      for (const row of next) rows.set(`${row.runId} ${row.prKey}`, row);
      for (const row of next)
        if (row.prKey !== "none") rows.delete(`${row.runId} none`);
      return Promise.resolve(next.length);
    },
    markReverted: (_scope, targets, mark) => {
      let n = 0;
      for (const [key, row] of rows) {
        if (
          row.provider === "github" &&
          !row.reverted &&
          targets.some(
            (t) => t.repository === row.repository && t.number === row.number,
          )
        ) {
          rows.set(key, withRevert(row, mark));
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };
  return { deps, rows, reads, saved, ledgerAsked };
}

const rowOf = (rows: Map<string, OutcomeRow>, runId: string, prKey: string) =>
  rows.get(`${runId} ${prKey}`);

describe("refreshRunPrOutcomes", () => {
  it("records a merged pull request with passing checks, and when each value was read", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      reasons: { tse_a1: "completed" },
      links: [link("tse_a1", 5)],
      forge: {
        "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(3), ci: "passed" }),
      },
    });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    const row = rowOf(t.rows, "tse_a1", "github:acme/app#5");
    expect(row).toMatchObject({
      runSource: "tacho",
      provider: "github",
      repository: "acme/app",
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      prState: "merged",
      prStateReadAt: NOW,
      merged: true,
      mergedAt: hoursAgo(3),
      closedAt: hoursAgo(3),
      mergeCommitSha: "c".repeat(40),
      ciState: "passed",
      ciReadAt: NOW,
      headBranchExists: false,
      headBranchReadAt: NOW,
      reverted: false,
      terminalReason: "completed",
      terminalReasonReadAt: NOW,
    });
    expect(out).toEqual({ runs: 1, forgeReads: 1, deferred: 0, rows: 1, reverted: 0 });
  });

  it("marks the original pull request reverted when a merged pull request's body reverts it", async () => {
    const t = fake({
      runs: [run("tse_a1"), run("tse_b2")],
      links: [link("tse_a1", 5), link("tse_b2", 9)],
      forge: {
        "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(5) }),
        "github:acme/app#9": forge("merged", {
          mergedAt: hoursAgo(2),
          body: "Reverts acme/app#5\n\nThis broke the build.",
        }),
      },
    });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      reverted: true,
      revertedBy: "github:acme/app#9",
      revertedAt: hoursAgo(2),
      revertedReadAt: NOW,
    });
    expect(rowOf(t.rows, "tse_b2", "github:acme/app#9")?.reverted).toBe(false);
    expect(out.reverted).toBe(1);
  });

  it("marks nothing reverted while the revert pull request is open", async () => {
    const t = fake({
      runs: [run("tse_a1"), run("tse_b2")],
      links: [link("tse_a1", 5), link("tse_b2", 9)],
      forge: {
        "github:acme/app#5": forge("merged"),
        "github:acme/app#9": forge("open", { body: "Reverts acme/app#5" }),
      },
    });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")?.reverted).toBe(false);
    expect(out.reverted).toBe(0);
  });

  it("records a pull request closed without merging, with its close time", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      links: [link("tse_a1", 7)],
      forge: {
        "github:acme/app#7": forge("closed", { updatedAt: hoursAgo(4), ci: "failed" }),
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#7")).toMatchObject({
      prState: "closed",
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      closedAt: hoursAgo(4),
      ciState: "failed",
    });
  });

  it("records an open pull request as open, with no close time", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      links: [link("tse_a1", 8)],
      forge: { "github:acme/app#8": forge("open", { ci: "pending", branch: true }) },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#8")).toMatchObject({
      prState: "open",
      merged: false,
      closedAt: null,
      ciState: "pending",
      headBranchExists: true,
    });
  });

  it("gives a run with no pull request one row with its terminal reason", async () => {
    const t = fake({
      runs: [run("tse_c3")],
      reasons: { tse_c3: "max_turns" },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect([...t.rows.values()]).toEqual([
      expect.objectContaining({
        runId: "tse_c3",
        prKey: "none",
        provider: null,
        repository: null,
        number: null,
        prState: null,
        terminalReason: "max_turns",
        terminalReasonReadAt: NOW,
      }),
    ]);
    expect(t.reads).toEqual([]);
  });

  it("names a ledger run's pull requests from its receipts, and waits on a run whose receipts it could not name", async () => {
    const t = fake({
      runs: [run("arun_d4", "ledger"), run("arun_e5", "ledger"), run("arun_f6", "ledger")],
      reasons: { arun_d4: "success", arun_e5: "failed", arun_f6: "success" },
      ledger: {
        arun_d4: [
          {
            provider: "github",
            repository: "acme/app",
            number: 12,
            url: "https://github.com/acme/app/pull/12",
            headSha: "b".repeat(40),
          },
        ],
        arun_e5: [],
      },
      forge: {
        "github:acme/app#12": forge("open", { headSha: "b".repeat(40), ci: "passed" }),
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "arun_d4", "github:acme/app#12")).toMatchObject({
      runSource: "ledger",
      headSha: "b".repeat(40),
      prState: "open",
      ciState: "passed",
      terminalReason: "success",
    });
    expect(rowOf(t.rows, "arun_e5", "none")).toMatchObject({
      terminalReason: "failed",
    });
    expect([...t.rows.keys()].some((k) => k.startsWith("arun_f6"))).toBe(false);
  });

  it("reads a ledger run's receipts only while the run has no row", async () => {
    const t = fake({
      runs: [run("arun_e5", "ledger")],
      ledger: { arun_e5: [] },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.ledgerAsked).toEqual([["arun_e5"], []]);
    expect(rowOf(t.rows, "arun_e5", "none")).toBeDefined();
  });

  it("writes nothing and reads nothing on a pass after the rows settled", async () => {
    const t = fake({
      runs: [run("tse_a1"), run("tse_c3")],
      reasons: { tse_a1: "completed", tse_c3: "max_turns" },
      links: [link("tse_a1", 5, { state: "merged", sourceUpdatedAt: hoursAgo(3) })],
      forge: { "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(3) }) },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    t.reads.length = 0;
    const second = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(second).toMatchObject({ forgeReads: 0, rows: 0 });
    expect(t.reads).toEqual([]);
    expect(t.saved.at(-1)).toEqual([]);
  });

  it("reads again a closed pull request whose head branch was read within the hour it closed", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      links: [link("tse_a1", 5)],
      forge: {
        "github:acme/app#5": forge("merged", { mergedAt: new Date(NOW.getTime() - 60_000) }),
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.reads).toEqual(["github:acme/app#5", "github:acme/app#5"]);
  });

  it("reads a pull request once when two runs name it, and updates both rows", async () => {
    const t = fake({
      runs: [run("tse_a1"), run("tse_b2")],
      links: [link("tse_a1", 5), link("tse_b2", 5)],
      forge: { "github:acme/app#5": forge("closed") },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.reads).toEqual(["github:acme/app#5"]);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")?.prState).toBe("closed");
    expect(rowOf(t.rows, "tse_b2", "github:acme/app#5")?.prState).toBe("closed");
  });

  it("reads at most 60 pull requests a pass and leaves the rest for the next", async () => {
    const links = Array.from({ length: 61 }, (_, i) => link("tse_a1", i + 1));
    const t = fake({ runs: [run("tse_a1")], links });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.reads).toHaveLength(60);
    expect(out.deferred).toBe(1);
    expect(t.rows.size).toBe(61);
  });

  it("moves a pull request GitHub refused, or a read that failed, behind one never asked", async () => {
    const links = Array.from({ length: 61 }, (_, i) => link("tse_a1", i + 1));
    const t = fake({
      runs: [run("tse_a1")],
      links,
      forge: {
        "github:acme/app#1": new Error("socket hang up"),
        "github:acme/app#61": forge("open", { ci: "pending", branch: true }),
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.reads).not.toContain("github:acme/app#61");
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#1")?.forgeReadAttemptedAt).toEqual(NOW);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#2")?.forgeReadAttemptedAt).toEqual(NOW);
    t.reads.length = 0;
    const second = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.reads[0]).toBe("github:acme/app#61");
    expect(second.forgeReads).toBe(1);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#61")).toMatchObject({
      prStateReadAt: NOW,
      ciState: "pending",
    });
  });

  it("does not count a pull request no GitHub source reads against the cap", async () => {
    const links = Array.from({ length: 61 }, (_, i) => link("tse_a1", i + 1));
    const forgeByKey: Record<string, ForgeOutcome> = {};
    for (let i = 1; i <= 61; i++) forgeByKey[`github:acme/app#${i}`] = "no_connection";
    const t = fake({ runs: [run("tse_a1")], links, forge: forgeByKey });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.reads).toHaveLength(61);
    expect(out).toMatchObject({ forgeReads: 0, deferred: 0 });
  });

  it("keeps the link's state when GitHub cannot be read, and goes on past a failed read", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      links: [link("tse_a1", 5, { state: "merged" }), link("tse_a1", 6)],
      forge: {
        "github:acme/app#5": new Error("socket hang up"),
        "github:acme/app#6": forge("open"),
      },
    });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      prState: "merged",
      prStateReadAt: hoursAgo(28),
      ciState: null,
    });
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#6")?.prState).toBe("open");
    expect(out.forgeReads).toBe(1);
  });

  it("replaces a run's none row when the run gains a pull request", async () => {
    const links: TachoPrLink[] = [];
    const t = fake({ runs: [run("tse_a1")], links });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "none")).toBeDefined();
    links.push(link("tse_a1", 5));
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "none")).toBeUndefined();
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")?.prState).toBe("open");
  });
});

describe("readGithubOutcome", () => {
  const pr = {
    provider: "github" as const,
    repository: "acme/app",
    number: 5,
    url: "https://github.com/acme/app/pull/5",
  };
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 5,
    state: "closed",
    merged: true,
    mergedAt: "2026-09-27T09:00:00Z",
    mergeCommitSha: "c".repeat(40),
    baseRef: "main",
    headRef: "feat/x",
    headSha: "a".repeat(40),
    body: "Reverts acme/app#3",
    updatedAt: "2026-09-27T09:00:05Z",
    htmlUrl: "https://github.com/acme/app/pull/5",
    ...over,
  });
  const passing = {
    sha: "a".repeat(40),
    checkRuns: [],
    statuses: [
      {
        context: "ci",
        state: "success",
        targetUrl: null,
        createdAt: "2026-09-27T08:50:00Z",
        updatedAt: "2026-09-27T08:55:00Z",
      },
    ],
  };
  const client = {
    getPullRequest: vi.fn(),
    listCiChecks: vi.fn(),
    getBranch: vi.fn(),
  };
  const asClient = client as unknown as GitHubClient;

  beforeEach(() => {
    client.getPullRequest.mockReset();
    client.listCiChecks.mockReset();
    client.getBranch.mockReset();
  });

  it("reads a merged pull request's state, its head commit's checks, and its deleted branch", async () => {
    client.getPullRequest.mockResolvedValue(pull());
    client.listCiChecks.mockResolvedValue(passing);
    client.getBranch.mockResolvedValue(null);
    const out = await readGithubOutcome(asClient, pr, () => NOW);
    expect(out).toEqual({
      state: {
        state: "merged",
        readAt: NOW,
        closedAt: null,
        mergedAt: new Date("2026-09-27T09:00:00Z"),
        mergeCommitSha: "c".repeat(40),
        baseRef: "main",
        headRef: "feat/x",
        headSha: "a".repeat(40),
        sourceUpdatedAt: new Date("2026-09-27T09:00:05Z"),
      },
      body: "Reverts acme/app#3",
      ci: { state: "passed", headSha: "a".repeat(40), readAt: NOW },
      headBranch: { exists: false, readAt: NOW },
    });
    expect(client.getPullRequest).toHaveBeenCalledWith({ owner: "acme", repo: "app", number: 5 });
    expect(client.listCiChecks).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      ref: "a".repeat(40),
    });
    expect(client.getBranch).toHaveBeenCalledWith({ owner: "acme", repo: "app", branch: "feat/x" });
  });

  it("reads a pull request closed without merging as closed", async () => {
    client.getPullRequest.mockResolvedValue(
      pull({ merged: false, mergedAt: null, mergeCommitSha: null }),
    );
    client.listCiChecks.mockResolvedValue({ sha: "a".repeat(40), checkRuns: [], statuses: [] });
    client.getBranch.mockResolvedValue({ name: "feat/x", sha: "a".repeat(40) });
    const out = await readGithubOutcome(asClient, pr, () => NOW);
    expect(out).toMatchObject({
      state: { state: "closed", mergedAt: null, mergeCommitSha: null },
      ci: { state: "none" },
      headBranch: { exists: true },
    });
  });

  it("answers unreadable when GitHub hides the pull request", async () => {
    client.getPullRequest.mockRejectedValue(new GitHubApiError(404, "Not Found"));
    expect(await readGithubOutcome(asClient, pr, () => NOW)).toBe("unreadable");
  });

  it("keeps the state when the checks or the branch cannot be read", async () => {
    client.getPullRequest.mockResolvedValue(pull({ state: "open", merged: false }));
    client.listCiChecks.mockRejectedValue(new GitHubApiError(403, "Forbidden"));
    client.getBranch.mockRejectedValue(new GitHubApiError(403, "Forbidden"));
    const out = await readGithubOutcome(asClient, pr, () => NOW);
    expect(out).toMatchObject({ state: { state: "open" }, ci: null, headBranch: null });
  });

  it("passes on an error that is not a refusal", async () => {
    client.getPullRequest.mockRejectedValue(new GitHubApiError(502, "Bad Gateway"));
    await expect(readGithubOutcome(asClient, pr, () => NOW)).rejects.toThrow("502");
  });
});

describe("readLedgerRunPrs", () => {
  const opened = (runSeq: number, repositoryId: string, number: number) =>
    event(runSeq, {
      eventType: "provider_publish.pull_request_opened",
      payload: {
        provider_repository_id: repositoryId,
        pull_request_number: number,
        head_commit_sha: "b".repeat(40),
      },
    });
  const repository = {
    connectionId: "conn-1",
    providerRepositoryId: "R_1",
    owner: "Acme",
    name: "App",
    host: "github.com",
    url: "https://github.com/Acme/App",
  };

  beforeEach(() => {
    mocks.connectedRunRepositories.mockReset();
    mocks.connectedRunRepositories.mockResolvedValue([repository]);
  });

  function store(events: Record<string, ReturnType<typeof event>[]>) {
    return {
      getRunByPublicId: vi.fn((publicId: string) =>
        Promise.resolve(publicId in events ? { runId: `uuid-${publicId}` } : null),
      ),
      readAttemptEventsSince: vi.fn((runId: string) =>
        Promise.resolve(events[runId.replace("uuid-", "")] ?? []),
      ),
    } as unknown as Parameters<typeof readLedgerRunPrs>[0];
  }

  it("names each receipt's pull request from the workspace's repositories", async () => {
    const out = await readLedgerRunPrs(
      store({ arun_d4: [opened(1, "R_1", 12)], arun_e5: [] }),
      SCOPE,
      ["arun_d4", "arun_e5"],
    );
    expect(out.get("arun_d4")).toEqual([
      {
        provider: "github",
        repository: "acme/app",
        number: 12,
        url: "https://github.com/Acme/App/pull/12",
        headSha: "b".repeat(40),
      },
    ]);
    expect(out.get("arun_e5")).toEqual([]);
  });

  it("leaves out a run whose only receipts name a repository the workspace no longer connects", async () => {
    const out = await readLedgerRunPrs(
      store({ arun_d4: [opened(1, "R_gone", 12)] }),
      SCOPE,
      ["arun_d4", "arun_missing"],
    );
    expect(out.size).toBe(0);
  });

  it("leaves out a run when one receipt names a connected repository and another does not", async () => {
    const out = await readLedgerRunPrs(
      store({ arun_d4: [opened(1, "R_1", 12), opened(2, "R_gone", 13)] }),
      SCOPE,
      ["arun_d4"],
    );
    expect(out.size).toBe(0);
  });
});
