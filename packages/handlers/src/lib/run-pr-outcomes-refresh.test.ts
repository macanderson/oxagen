import {
  blankOutcome,
  type OutcomeRow,
  type OutcomeRun,
  prKeyOf,
  type PrStateRead,
  type RevertEvidence,
  type RunPrCiState,
  type RunPrState,
  type TachoPrLink,
} from "@oxagen/billing";
import { GitHubApiError, type GitHubClient } from "@oxagen/github";
import type { AttemptEventReadRecord } from "@oxagen/run-ledger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { event } from "../run.test-support";
import {
  type ForgeOutcome,
  type ForgeOutcomeRead,
  type LedgerRunPr,
  type LedgerRunRead,
  OUTCOME_LEDGER_READS_PER_PASS,
  OUTCOME_RUN_ID_BATCH,
  OUTCOME_UNRESOLVED_RETRY_MS,
  type OutcomeRefreshDeps,
  RECEIPT_WALK_PAGE,
  RECEIPT_WALK_PAGES,
  readGithubOutcome,
  readLedgerRunPrs,
  refreshRunPrOutcomes,
  walkLedgerReceipts,
} from "./run-pr-outcomes-refresh";
import type { ReceiptWalk } from "./run-pr-receipt-walks";

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
const daysAgo = (d: number) => hoursAgo(d * 24);

const run = (
  runId: string,
  runSource: "ledger" | "tacho" = "tacho",
  startedHoursAgo = 30,
): OutcomeRun => ({
  runId,
  runSource,
  startedAt: hoursAgo(startedHoursAgo),
  sealedAt: hoursAgo(startedHoursAgo - 1),
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
  baseRef?: string;
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
      baseRef: opts.baseRef ?? "main",
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
  /**
   * The pull requests each ledger run's complete walk names. A run left out
   * names a repository the workspace does not connect.
   */
  ledger?: Record<string, LedgerRunPr[]>;
  /** In place of `ledger`, the production reader over a fake ledger. */
  ledgerPrs?: OutcomeRefreshDeps["ledgerPrs"];
  forge?: Record<string, ForgeOutcome | Error>;
  /** Reverts already kept, as a GitHub delivery or an earlier pass keeps them. */
  reverts?: RevertEvidence[];
  /** The newest state a GitHub delivery kept for each pull request, by pr key. */
  delivered?: Record<string, PrStateRead>;
}

const sameRevert = (a: RevertEvidence, b: RevertEvidence) =>
  a.repository === b.repository &&
  a.number === b.number &&
  a.mergeCommitSha === b.mergeCommitSha &&
  a.branch === b.branch &&
  a.mark.by === b.mark.by;

/** Dependencies over an in-memory table and revert store, which save as the store does. */
function fake(input: FakeInput) {
  const rows = new Map<string, OutcomeRow>();
  const reads: string[] = [];
  const saved: OutcomeRow[][] = [];
  const ledgerAsked: string[][] = [];
  const walks = new Map<string, ReceiptWalk>();
  /** The run ids each batched read named, per read. */
  const batches = {
    readRows: [] as number[],
    terminalReasons: [] as number[],
    tachoLinks: [] as number[],
    receiptWalks: [] as number[],
  };
  const reverts: RevertEvidence[] = [...(input.reverts ?? [])];
  const revertsAsked: Date[] = [];
  const writes: string[] = [];
  const deliveredAsked: string[][] = [];
  const control = { failSaveRows: false, now: NOW };
  const deps: OutcomeRefreshDeps = {
    now: () => control.now,
    listRuns: () => Promise.resolve(input.runs),
    terminalReasons: (_scope, batch) => {
      batches.terminalReasons.push(batch.length);
      const ids = new Set(batch.map((r) => r.runId));
      return Promise.resolve(
        new Map(Object.entries(input.reasons ?? {}).filter(([id]) => ids.has(id))),
      );
    },
    readRows: (_scope, ids) => {
      batches.readRows.push(ids.length);
      const named = new Set(ids);
      return Promise.resolve([...rows.values()].filter((r) => named.has(r.runId)));
    },
    tachoLinks: (_scope, ids) => {
      batches.tachoLinks.push(ids.length);
      return Promise.resolve((input.links ?? []).filter((l) => ids.includes(l.runId)));
    },
    receiptWalks: (_scope, ids) => {
      batches.receiptWalks.push(ids.length);
      return Promise.resolve(ids.flatMap((id) => walks.get(id) ?? []));
    },
    ledgerPrs: (scope, requests, now) => {
      ledgerAsked.push(requests.map((r) => r.runId));
      if (input.ledgerPrs) return input.ledgerPrs(scope, requests, now);
      return Promise.resolve(
        requests.map((r): LedgerRunRead => {
          const prs = input.ledger?.[r.runId];
          const walk: ReceiptWalk = {
            runId: r.runId,
            afterSeq: "1",
            complete: true,
            receipts: [],
            attemptedAt: now,
            unresolved: prs ? null : "repository_not_connected",
            retryAfter: prs ? null : new Date(now.getTime() + OUTCOME_UNRESOLVED_RETRY_MS),
          };
          return { walk, prs: prs ?? null };
        }),
      );
    },
    saveReceiptWalks: (_scope, next) => {
      writes.push("saveReceiptWalks");
      for (const walk of next) walks.set(walk.runId, walk);
      return Promise.resolve();
    },
    readForge: (_scope, pr) => {
      const key = prKeyOf(pr.provider, pr.repository, pr.number);
      reads.push(key);
      const found = input.forge?.[key] ?? "unreadable";
      return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
    },
    deliveredStates: (_scope, keys) => {
      deliveredAsked.push([...keys]);
      return Promise.resolve(
        keys.flatMap((prKey) => {
          const state = input.delivered?.[prKey];
          return state ? [{ prKey, state }] : [];
        }),
      );
    },
    readReverts: (_scope, since) => {
      revertsAsked.push(since);
      return Promise.resolve(
        reverts.filter((e) => e.mark.readAt.getTime() >= since.getTime()),
      );
    },
    saveReverts: (_scope, evidence) => {
      writes.push("saveReverts");
      let n = 0;
      for (const e of evidence) {
        if (reverts.some((kept) => sameRevert(kept, e))) continue;
        reverts.push(e);
        n += 1;
      }
      return Promise.resolve(n);
    },
    saveRows: (_scope, next) => {
      writes.push("saveRows");
      if (control.failSaveRows)
        return Promise.reject(new Error("connection terminated"));
      saved.push([...next]);
      for (const row of next) rows.set(`${row.runId} ${row.prKey}`, row);
      for (const row of next)
        if (row.prKey !== "none") rows.delete(`${row.runId} none`);
      return Promise.resolve(next.length);
    },
  };
  return {
    deps,
    rows,
    reads,
    saved,
    ledgerAsked,
    walks,
    batches,
    reverts,
    revertsAsked,
    writes,
    deliveredAsked,
    control,
  };
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

  it("keeps the reverts it found before it writes any row, so a failed write loses none", async () => {
    const forgeByKey: Record<string, ForgeOutcome | Error> = {
      "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(5) }),
      "github:acme/app#9": forge("merged", {
        mergedAt: hoursAgo(2),
        body: "Reverts acme/app#5",
      }),
    };
    const t = fake({
      runs: [run("tse_a1"), run("tse_b2")],
      links: [link("tse_a1", 5), link("tse_b2", 9)],
      forge: forgeByKey,
    });
    t.control.failSaveRows = true;
    await expect(refreshRunPrOutcomes(t.deps, SCOPE)).rejects.toThrow(
      "connection terminated",
    );
    expect(t.writes).toEqual(["saveReverts", "saveRows"]);
    expect(t.reverts).toEqual([
      {
        repository: "acme/app",
        number: 5,
        mergeCommitSha: null,
        branch: "main",
        mark: { by: "github:acme/app#9", at: hoursAgo(2), readAt: NOW },
      },
    ]);
    // The next pass cannot read the reverting pull request, so only the kept
    // revert can mark the row.
    t.control.failSaveRows = false;
    forgeByKey["github:acme/app#9"] = "unreadable";
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      reverted: true,
      revertedBy: "github:acme/app#9",
      revertedAt: hoursAgo(2),
      revertedReadAt: NOW,
    });
    expect(out.reverted).toBe(1);
  });

  it("marks a row first written after the pass that found its revert", async () => {
    const runs = [run("tse_b2")];
    const t = fake({
      runs,
      links: [link("tse_b2", 9), link("tse_a1", 5)],
      forge: {
        "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(5) }),
        "github:acme/app#9": forge("merged", {
          mergedAt: hoursAgo(2),
          body: "Reverts acme/app#5",
        }),
      },
    });
    const first = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(first.reverted).toBe(0);
    t.reads.length = 0;
    runs.push(run("tse_a1"));
    const second = await refreshRunPrOutcomes(t.deps, SCOPE);
    // The reverting pull request settled on the first pass and is not read again.
    expect(t.reads).toEqual(["github:acme/app#5"]);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      reverted: true,
      revertedBy: "github:acme/app#9",
      revertedAt: hoursAgo(2),
    });
    expect(second.reverted).toBe(1);
  });

  it("marks a new row with a revert a GitHub delivery kept before the row existed", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      links: [link("tse_a1", 5)],
      forge: { "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(5) }) },
      reverts: [
        {
          repository: "acme/app",
          number: 5,
          mergeCommitSha: null,
          branch: "main",
          mark: { by: "github:acme/app#9", at: hoursAgo(4), readAt: hoursAgo(4) },
        },
      ],
    });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.revertsAsked).toEqual([new Date(NOW.getTime() - 30 * 86_400_000)]);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      reverted: true,
      revertedBy: "github:acme/app#9",
      revertedAt: hoursAgo(4),
      revertedReadAt: hoursAgo(4),
    });
    expect(out.reverted).toBe(1);
  });

  it("marks a row by a kept merge commit revert only on the branch the revert landed on", async () => {
    const onMain = `github:acme/app@${"e".repeat(40)}`;
    const t = fake({
      runs: [run("tse_a1"), run("tse_b2")],
      links: [link("tse_a1", 5), link("tse_b2", 6)],
      forge: {
        "github:acme/app#5": forge("merged", { mergeCommitSha: "c".repeat(40) }),
        "github:acme/app#6": forge("merged", { mergeCommitSha: "d".repeat(40) }),
      },
      reverts: [
        {
          repository: "acme/app",
          number: null,
          mergeCommitSha: "c".repeat(40),
          branch: "main",
          mark: { by: onMain, at: hoursAgo(2), readAt: hoursAgo(2) },
        },
        {
          repository: "acme/app",
          number: null,
          mergeCommitSha: "d".repeat(40),
          branch: "release",
          mark: {
            by: `github:acme/app@${"f".repeat(40)}`,
            at: hoursAgo(2),
            readAt: hoursAgo(2),
          },
        },
      ],
    });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      reverted: true,
      revertedBy: onMain,
    });
    expect(rowOf(t.rows, "tse_b2", "github:acme/app#6")?.reverted).toBe(false);
    expect(out.reverted).toBe(1);
  });

  it("marks a pull request reverted only by a revert that merged into the same branch", async () => {
    // #9 merged into release and says it reverts #5, which merged into main.
    const intoRelease = fake({
      runs: [run("tse_a1"), run("tse_b2")],
      links: [link("tse_a1", 5), link("tse_b2", 9)],
      forge: {
        "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(5) }),
        "github:acme/app#9": forge("merged", {
          mergedAt: hoursAgo(2),
          baseRef: "release",
          body: "Reverts acme/app#5",
        }),
      },
    });
    const out = await refreshRunPrOutcomes(intoRelease.deps, SCOPE);
    expect(rowOf(intoRelease.rows, "tse_a1", "github:acme/app#5")?.reverted).toBe(false);
    expect(out.reverted).toBe(0);
    expect(intoRelease.reverts).toMatchObject([{ number: 5, branch: "release" }]);

    // The same revert merged into main marks it.
    const intoMain = fake({
      runs: [run("tse_a1"), run("tse_b2")],
      links: [link("tse_a1", 5), link("tse_b2", 9)],
      forge: {
        "github:acme/app#5": forge("merged", { mergedAt: hoursAgo(5) }),
        "github:acme/app#9": forge("merged", {
          mergedAt: hoursAgo(2),
          body: "Reverts acme/app#5",
        }),
      },
    });
    expect((await refreshRunPrOutcomes(intoMain.deps, SCOPE)).reverted).toBe(1);
    expect(rowOf(intoMain.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      reverted: true,
      revertedBy: "github:acme/app#9",
    });
  });

  it("keeps no revert of a pull request in another repository", async () => {
    const t = fake({
      runs: [run("tse_b2")],
      links: [link("tse_b2", 9)],
      forge: {
        "github:acme/app#9": forge("merged", { body: "Reverts acme/lib#3" }),
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.reverts).toEqual([]);
  });

  it("does not mark a release pull request by a kept merge commit revert with no branch", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      links: [link("tse_a1", 5)],
      forge: {
        "github:acme/app#5": forge("merged", {
          baseRef: "release",
          mergeCommitSha: "c".repeat(40),
        }),
      },
      reverts: [
        {
          repository: "acme/app",
          number: null,
          mergeCommitSha: "c".repeat(40),
          branch: null,
          mark: { by: `github:acme/app@${"e".repeat(40)}`, at: hoursAgo(2), readAt: hoursAgo(2) },
        },
      ],
    });
    const out = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")?.reverted).toBe(false);
    expect(out.reverted).toBe(0);
  });

  it("writes a run's first row open when a delivery kept a reopen newer than the GitHub read", async () => {
    // The pass read #12 closed. #12 reopened a minute later, and its delivery
    // landed before the pass wrote the run's first row, so it found no row.
    const reopenedAt = new Date(NOW.getTime() + 60_000);
    const t = fake({
      runs: [run("arun_d4", "ledger")],
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
      },
      forge: {
        "github:acme/app#12": forge("closed", {
          headSha: "b".repeat(40),
          updatedAt: hoursAgo(2),
          ci: "failed",
        }),
      },
      delivered: {
        "github:acme/app#12": {
          state: "open",
          readAt: new Date(reopenedAt.getTime() + 2_000),
          closedAt: null,
          mergedAt: null,
          mergeCommitSha: null,
          baseRef: "main",
          headRef: "feat/x",
          headSha: "b".repeat(40),
          sourceUpdatedAt: reopenedAt,
        },
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.deliveredAsked).toEqual([["github:acme/app#12"]]);
    expect(rowOf(t.rows, "arun_d4", "github:acme/app#12")).toMatchObject({
      prState: "open",
      closedAt: null,
      sourceUpdatedAt: reopenedAt,
    });
  });

  it("keeps the GitHub read when the delivery kept for the pull request is older", async () => {
    const t = fake({
      runs: [run("tse_a1")],
      links: [link("tse_a1", 7)],
      forge: {
        "github:acme/app#7": forge("closed", { updatedAt: hoursAgo(2) }),
      },
      delivered: {
        "github:acme/app#7": {
          state: "open",
          readAt: hoursAgo(5),
          closedAt: null,
          mergedAt: null,
          mergeCommitSha: null,
          baseRef: "main",
          headRef: "feat/x",
          headSha: "a".repeat(40),
          sourceUpdatedAt: hoursAgo(5),
        },
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#7")).toMatchObject({
      prState: "closed",
      closedAt: hoursAgo(2),
    });
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

  it("reads a ledger run's receipts until its walk is complete, and not again", async () => {
    const t = fake({
      runs: [run("arun_e5", "ledger")],
      ledger: { arun_e5: [] },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.ledgerAsked).toEqual([["arun_e5"]]);
    expect(rowOf(t.rows, "arun_e5", "none")).toBeDefined();
    expect(t.walks.get("arun_e5")).toMatchObject({ complete: true, unresolved: null });
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

  it("stops reading a closed or merged pull request 14 days after it closed, even with CI pending", async () => {
    const seen = { stateSeenAt: daysAgo(16), sourceUpdatedAt: daysAgo(16) };
    const t = fake({
      runs: [run("tse_a1", "tacho", 20 * 24), run("tse_b2", "tacho", 20 * 24), run("tse_c3", "tacho", 20 * 24)],
      links: [link("tse_a1", 5, seen), link("tse_b2", 6, seen), link("tse_c3", 7, seen)],
      forge: {
        "github:acme/app#5": forge("closed", { updatedAt: daysAgo(15), ci: "pending" }),
        "github:acme/app#6": forge("merged", {
          mergedAt: daysAgo(15),
          ci: "pending",
          branch: null,
        }),
        "github:acme/app#7": forge("closed", { updatedAt: daysAgo(2), ci: "pending" }),
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "tse_a1", "github:acme/app#5")).toMatchObject({
      prState: "closed",
      closedAt: daysAgo(15),
      ciState: "pending",
    });
    t.reads.length = 0;
    await refreshRunPrOutcomes(t.deps, SCOPE);
    // Only the pull request that closed two days ago is read again.
    expect(t.reads).toEqual(["github:acme/app#7"]);
  });

  it("binds at most OUTCOME_RUN_ID_BATCH run ids per read, and reads every stored row back", async () => {
    const tacho = Array.from({ length: OUTCOME_RUN_ID_BATCH * 2 + 500 }, (_, i) =>
      run(`tse_${i.toString(36)}`),
    );
    const ledgerRuns = Array.from({ length: OUTCOME_RUN_ID_BATCH + 500 }, (_, i) =>
      run(`arun_${i.toString(36)}`, "ledger"),
    );
    const t = fake({
      runs: [...tacho, ...ledgerRuns],
      ledger: Object.fromEntries(ledgerRuns.map((r) => [r.runId, []])),
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.batches.readRows).toEqual([1000, 1000, 1000, 1000]);
    expect(t.batches.terminalReasons).toEqual([1000, 1000, 1000, 1000]);
    expect(t.batches.tachoLinks).toEqual([1000, 1000, 500]);
    expect(t.batches.receiptWalks).toEqual([1000, 500]);
    // Every wrapped run, and the first 100 ledger runs, have their none row.
    expect(t.rows.size).toBe(tacho.length + OUTCOME_LEDGER_READS_PER_PASS);
    const second = await refreshRunPrOutcomes(t.deps, SCOPE);
    // The rows written on the first pass come back through the batched reads
    // and are not written again. Only the next 100 ledger runs' rows are new.
    expect(second.rows).toBe(OUTCOME_LEDGER_READS_PER_PASS);
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

  it("reads a fork pull request's head branch in the fork", async () => {
    client.getPullRequest.mockResolvedValue(
      pull({ state: "open", merged: false, headRepository: "forker/app-fork" }),
    );
    client.listCiChecks.mockResolvedValue(passing);
    client.getBranch.mockResolvedValue({ name: "feat/x", sha: "a".repeat(40) });
    const out = await readGithubOutcome(asClient, pr, () => NOW);
    expect(client.getBranch).toHaveBeenCalledWith({
      owner: "forker",
      repo: "app-fork",
      branch: "feat/x",
    });
    // The checks of the head commit are read in the base repository.
    expect(client.listCiChecks).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      ref: "a".repeat(40),
    });
    expect(out).toMatchObject({ headBranch: { exists: true, readAt: NOW } });
  });

  it("reads the head branch as gone when the fork it came from was deleted", async () => {
    client.getPullRequest.mockResolvedValue(pull({ headRepository: null }));
    client.listCiChecks.mockResolvedValue(passing);
    const out = await readGithubOutcome(asClient, pr, () => NOW);
    expect(client.getBranch).not.toHaveBeenCalled();
    expect(out).toMatchObject({ headBranch: { exists: false, readAt: NOW } });
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

  it("reads CI as pending when the checks read stopped short of the last check", async () => {
    client.getPullRequest.mockResolvedValue(pull());
    client.listCiChecks.mockResolvedValue({ ...passing, complete: false });
    client.getBranch.mockResolvedValue(null);
    const out = await readGithubOutcome(asClient, pr, () => NOW);
    expect(out).toMatchObject({ ci: { state: "pending", headSha: "a".repeat(40) } });
  });

  it("reads CI as failed from a partial read when a check it read failed", async () => {
    client.getPullRequest.mockResolvedValue(pull());
    client.listCiChecks.mockResolvedValue({
      ...passing,
      statuses: [
        {
          context: "ci",
          state: "failure",
          targetUrl: null,
          createdAt: "2026-09-27T08:50:00Z",
          updatedAt: "2026-09-27T08:55:00Z",
        },
      ],
      complete: false,
    });
    client.getBranch.mockResolvedValue(null);
    const out = await readGithubOutcome(asClient, pr, () => NOW);
    expect(out).toMatchObject({ ci: { state: "failed" } });
  });
});

const opened = (runSeq: number, repositoryId: string, number: number) =>
  event(runSeq, {
    eventType: "provider_publish.pull_request_opened",
    payload: {
      provider_repository_id: repositoryId,
      pull_request_number: number,
      head_commit_sha: "b".repeat(40),
    },
  });

/** `count` events from run_seq 1, each a plain tool call unless `receipts` puts a receipt at its seq. */
function eventsOf(
  count: number,
  receipts: Record<number, [repositoryId: string, number: number]> = {},
): AttemptEventReadRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const seq = i + 1;
    const receipt = receipts[seq];
    return receipt ? opened(seq, receipt[0], receipt[1]) : event(seq);
  });
}

/**
 * A run store over in-memory events keyed by run public id, cursored on
 * run_seq as the Postgres store reads them. A run in `failing` throws on read.
 */
function ledgerOf(
  events: Record<string, AttemptEventReadRecord[]>,
  failing: ReadonlySet<string> = new Set(),
) {
  const pages: { runId: string; after: string }[] = [];
  const store = {
    getRunByPublicId: vi.fn((publicId: string) =>
      Promise.resolve(publicId in events ? { runId: `uuid-${publicId}` } : null),
    ),
    readAttemptEventsSince: vi.fn((runId: string, after: string, limit = 500) => {
      const publicId = runId.replace("uuid-", "");
      pages.push({ runId: publicId, after });
      if (failing.has(publicId))
        return Promise.reject(new Error("archive segment unreadable"));
      return Promise.resolve(
        (events[publicId] ?? [])
          .filter((e) => Number(e.runSeq) > Number(after))
          .slice(0, limit),
      );
    }),
  };
  return {
    store: store as unknown as Parameters<typeof readLedgerRunPrs>[0],
    pages,
  };
}

const connected = {
  connectionId: "conn-1",
  providerRepositoryId: "R_1",
  owner: "Acme",
  name: "App",
  host: "github.com",
  url: "https://github.com/Acme/App",
};

const WALK_BOUND = RECEIPT_WALK_PAGE * RECEIPT_WALK_PAGES;

describe("walkLedgerReceipts", () => {
  it("reads every event when the run ends inside the bound", async () => {
    const { store } = ledgerOf({ arun_d4: eventsOf(3, { 2: ["R_1", 12] }) });
    expect(await walkLedgerReceipts(store, "uuid-arun_d4", null)).toEqual({
      receipts: [{ repositoryId: "R_1", number: 12, headSha: "b".repeat(40) }],
      afterSeq: "3",
      complete: true,
    });
  });

  it("stops at the bound with the last event it read, and resumes after it", async () => {
    const { store, pages } = ledgerOf({
      arun_d4: eventsOf(WALK_BOUND + 300, { 3: ["R_1", 12], [WALK_BOUND + 200]: ["R_1", 13] }),
    });
    const first = await walkLedgerReceipts(store, "uuid-arun_d4", null);
    expect(first).toMatchObject({ afterSeq: String(WALK_BOUND), complete: false });
    expect(first.receipts.map((r) => r.number)).toEqual([12]);
    expect(pages).toHaveLength(RECEIPT_WALK_PAGES);
    const second = await walkLedgerReceipts(store, "uuid-arun_d4", first.afterSeq);
    expect(second).toMatchObject({ afterSeq: String(WALK_BOUND + 300), complete: true });
    expect(second.receipts.map((r) => r.number)).toEqual([13]);
    expect(pages.at(-1)).toEqual({ runId: "arun_d4", after: String(WALK_BOUND) });
  });

  it("skips a receipt whose number could not be stored", async () => {
    const { store } = ledgerOf({ arun_d4: [opened(1, "R_1", 0), opened(2, "R_1", 1.5)] });
    expect(await walkLedgerReceipts(store, "uuid-arun_d4", null)).toEqual({
      receipts: [],
      afterSeq: "2",
      complete: true,
    });
  });

  it("keeps its position when a resumed walk finds no new event", async () => {
    const { store } = ledgerOf({ arun_d4: eventsOf(WALK_BOUND) });
    const first = await walkLedgerReceipts(store, "uuid-arun_d4", null);
    expect(first).toMatchObject({ afterSeq: String(WALK_BOUND), complete: false });
    expect(await walkLedgerReceipts(store, "uuid-arun_d4", first.afterSeq)).toEqual({
      receipts: [],
      afterSeq: String(WALK_BOUND),
      complete: true,
    });
  });
});

describe("readLedgerRunPrs", () => {
  beforeEach(() => {
    mocks.connectedRunRepositories.mockReset();
    mocks.connectedRunRepositories.mockResolvedValue([connected]);
  });

  const fresh = (runId: string) => ({ runId, walk: null });

  it("names each receipt's pull request from the workspace's repositories", async () => {
    const { store } = ledgerOf({ arun_d4: [opened(1, "R_1", 12)], arun_e5: [] });
    const out = await readLedgerRunPrs(store, SCOPE, [fresh("arun_d4"), fresh("arun_e5")], NOW);
    expect(out).toEqual([
      {
        walk: {
          runId: "arun_d4",
          afterSeq: "1",
          complete: true,
          receipts: [{ repositoryId: "R_1", number: 12, headSha: "b".repeat(40) }],
          attemptedAt: NOW,
          unresolved: null,
          retryAfter: null,
        },
        prs: [
          {
            provider: "github",
            repository: "acme/app",
            number: 12,
            url: "https://github.com/Acme/App/pull/12",
            headSha: "b".repeat(40),
          },
        ],
      },
      {
        walk: {
          runId: "arun_e5",
          afterSeq: null,
          complete: true,
          receipts: [],
          attemptedAt: NOW,
          unresolved: null,
          retryAfter: null,
        },
        prs: [],
      },
    ]);
  });

  it("holds back a run when one receipt names a repository the workspace no longer connects", async () => {
    const { store } = ledgerOf({ arun_d4: [opened(1, "R_1", 12), opened(2, "R_gone", 13)] });
    const [out] = await readLedgerRunPrs(store, SCOPE, [fresh("arun_d4")], NOW);
    expect(out).toMatchObject({
      prs: null,
      walk: {
        complete: true,
        unresolved: "repository_not_connected",
        retryAfter: new Date(NOW.getTime() + OUTCOME_UNRESOLVED_RETRY_MS),
      },
    });
    expect(out?.walk.receipts).toHaveLength(2);
  });

  it("names a complete walk's kept receipts on a retry without reading an event", async () => {
    const { store, pages } = ledgerOf({ arun_d4: [] });
    const walk: ReceiptWalk = {
      runId: "arun_d4",
      afterSeq: "7",
      complete: true,
      receipts: [{ repositoryId: "R_1", number: 12, headSha: null }],
      attemptedAt: hoursAgo(7),
      unresolved: "repository_not_connected",
      retryAfter: hoursAgo(1),
    };
    const [out] = await readLedgerRunPrs(store, SCOPE, [{ runId: "arun_d4", walk }], NOW);
    expect(pages).toEqual([]);
    expect(out?.walk).toMatchObject({ unresolved: null, retryAfter: null, attemptedAt: NOW });
    expect(out?.prs?.map((p) => p.number)).toEqual([12]);
  });

  it("records a run the ledger does not find, and one whose events cannot be read, with a retry time", async () => {
    const { store } = ledgerOf({ arun_bad: [opened(1, "R_1", 7)] }, new Set(["arun_bad"]));
    const out = await readLedgerRunPrs(
      store,
      SCOPE,
      [fresh("arun_missing"), fresh("arun_bad")],
      NOW,
    );
    const retryAfter = new Date(NOW.getTime() + OUTCOME_UNRESOLVED_RETRY_MS);
    expect(out.map((r) => r.walk)).toEqual([
      expect.objectContaining({ unresolved: "run_not_found", retryAfter, afterSeq: null }),
      expect.objectContaining({
        unresolved: "read_failed",
        retryAfter,
        afterSeq: null,
        complete: false,
      }),
    ]);
    expect(out.every((r) => r.prs === null)).toBe(true);
  });
});

describe("refreshRunPrOutcomes over ledger runs", () => {
  beforeEach(() => {
    mocks.connectedRunRepositories.mockReset();
    mocks.connectedRunRepositories.mockResolvedValue([connected]);
  });

  const over = (ledger: ReturnType<typeof ledgerOf>): OutcomeRefreshDeps["ledgerPrs"] =>
    (scope, runs, now) => readLedgerRunPrs(ledger.store, scope, runs, now);

  it("has a row for every pull request of a run whose receipts pass the walk bound, by the second pass", async () => {
    const ledger = ledgerOf({
      arun_d4: eventsOf(WALK_BOUND + 300, { 3: ["R_1", 12], [WALK_BOUND + 200]: ["R_1", 13] }),
    });
    const t = fake({
      runs: [run("arun_d4", "ledger")],
      reasons: { arun_d4: "success" },
      ledgerPrs: over(ledger),
      forge: {
        "github:acme/app#12": forge("open"),
        "github:acme/app#13": forge("open"),
      },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    // The first pass stops at the bound and writes no row: rows for part of
    // the run would read as all of it.
    expect(t.rows.size).toBe(0);
    expect(t.walks.get("arun_d4")).toMatchObject({
      afterSeq: String(WALK_BOUND),
      complete: false,
      unresolved: null,
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(ledger.pages.filter((p) => p.after === "0")).toHaveLength(1);
    expect(rowOf(t.rows, "arun_d4", "github:acme/app#12")).toMatchObject({
      prState: "open",
      terminalReason: "success",
    });
    expect(rowOf(t.rows, "arun_d4", "github:acme/app#13")).toMatchObject({
      prState: "open",
    });
    expect(t.walks.get("arun_d4")).toMatchObject({ complete: true });
    // A complete walk is not read again.
    const pagesBefore = ledger.pages.length;
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(ledger.pages).toHaveLength(pagesBefore);
  });

  it("reads an older run past more than 100 newer runs it cannot resolve", async () => {
    const newer = OUTCOME_LEDGER_READS_PER_PASS + 1;
    const events: Record<string, AttemptEventReadRecord[]> = {
      arun_old: [opened(1, "R_1", 40)],
    };
    const runs = [run("arun_old", "ledger", 200)];
    for (let i = 0; i < newer; i++) {
      const runId = `arun_n${i.toString(36)}`;
      events[runId] = [opened(1, "R_gone", 100 + i)];
      runs.push(run(runId, "ledger", 10 + i / 100));
    }
    const t = fake({
      runs,
      ledgerPrs: over(ledgerOf(events)),
      forge: { "github:acme/app#40": forge("open") },
    });
    const first = await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.ledgerAsked[0]).toHaveLength(OUTCOME_LEDGER_READS_PER_PASS);
    expect(t.ledgerAsked[0]).not.toContain("arun_old");
    expect(t.rows.size).toBe(0);
    expect(first.deferred).toBe(2);
    expect(t.walks.get("arun_n0")).toMatchObject({
      unresolved: "repository_not_connected",
      retryAfter: new Date(NOW.getTime() + OUTCOME_UNRESOLVED_RETRY_MS),
    });
    // The runs it could not resolve wait for their retry time and take no
    // slot, so the next pass reaches the older run.
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.ledgerAsked[1]).toEqual([`arun_n${(newer - 1).toString(36)}`, "arun_old"]);
    expect(rowOf(t.rows, "arun_old", "github:acme/app#40")).toMatchObject({
      prState: "open",
    });
    // At their retry time they are read again.
    t.control.now = new Date(NOW.getTime() + OUTCOME_UNRESOLVED_RETRY_MS);
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.ledgerAsked[2]).toHaveLength(OUTCOME_LEDGER_READS_PER_PASS);
    expect(t.ledgerAsked[2]).not.toContain("arun_old");
  });

  it("goes on past a run whose events cannot be read", async () => {
    const ledger = ledgerOf(
      { arun_bad: [opened(1, "R_1", 7)], arun_ok: [opened(1, "R_1", 8)] },
      new Set(["arun_bad"]),
    );
    const t = fake({
      runs: [run("arun_bad", "ledger", 10), run("arun_ok", "ledger", 20)],
      ledgerPrs: over(ledger),
      forge: { "github:acme/app#8": forge("open") },
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(t.walks.get("arun_bad")).toMatchObject({
      unresolved: "read_failed",
      afterSeq: null,
      complete: false,
    });
    expect(rowOf(t.rows, "arun_ok", "github:acme/app#8")).toBeDefined();
  });

  it("walks once a run named before walks were kept, and adds the pull requests the old bound missed", async () => {
    const ledger = ledgerOf({
      arun_d4: eventsOf(WALK_BOUND + 10, { 3: ["R_1", 12], [WALK_BOUND + 5]: ["R_1", 13] }),
    });
    const t = fake({
      runs: [run("arun_d4", "ledger")],
      ledgerPrs: over(ledger),
      forge: {
        "github:acme/app#12": forge("open"),
        "github:acme/app#13": forge("open"),
      },
    });
    const pr12 = {
      provider: "github" as const,
      repository: "acme/app",
      number: 12,
      url: "https://github.com/Acme/App/pull/12",
    };
    t.rows.set("arun_d4 github:acme/app#12", {
      ...blankOutcome("arun_d4", "ledger", pr12),
      prState: "open",
      prStateReadAt: hoursAgo(2),
    });
    await refreshRunPrOutcomes(t.deps, SCOPE);
    await refreshRunPrOutcomes(t.deps, SCOPE);
    expect(rowOf(t.rows, "arun_d4", "github:acme/app#13")).toMatchObject({
      prState: "open",
    });
    expect(rowOf(t.rows, "arun_d4", "github:acme/app#12")?.prState).toBe("open");
  });
});

