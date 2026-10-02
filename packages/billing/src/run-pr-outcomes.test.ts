import { describe, expect, it } from "vitest";
import {
  blankOutcome,
  ciStateOf,
  ciStateOfRead,
  HEAD_BRANCH_SETTLE_MS,
  ledgerTerminalReason,
  needsForgeRead,
  OUTCOME_SETTLE_DAYS,
  type OutcomeRow,
  outcomeDeliveryOf,
  type PrStateRead,
  prKeyOf,
  repositoryOfCommitUrl,
  revertedShasOf,
  type RevertEvidence,
  revertEvidenceOf,
  revertPlanOf,
  revertTargetsOf,
  tachoTerminalReason,
  withCiRead,
  withRevert,
  withStateRead,
  withStoredReverts,
} from "./run-pr-outcomes";

const at = (iso: string) => new Date(iso);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_M = "1234567890abcdef1234567890abcdef12345678";

const pr = {
  provider: "github" as const,
  repository: "Acme/App",
  number: 5,
  url: "https://github.com/Acme/App/pull/5",
};

const read = (over: Partial<PrStateRead> = {}): PrStateRead => ({
  state: "open",
  readAt: at("2026-09-27T10:00:00Z"),
  closedAt: null,
  mergedAt: null,
  mergeCommitSha: null,
  baseRef: "main",
  headRef: "feat/x",
  headSha: SHA_A,
  sourceUpdatedAt: at("2026-09-27T09:59:00Z"),
  ...over,
});

const settled = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
  ...blankOutcome("tse_a1", "tacho", pr),
  prState: "merged",
  prStateReadAt: at("2026-09-27T12:00:00Z"),
  merged: true,
  mergedAt: at("2026-09-27T10:00:00Z"),
  closedAt: at("2026-09-27T10:00:00Z"),
  ciState: "passed",
  ciReadAt: at("2026-09-27T12:00:00Z"),
  headBranchExists: false,
  headBranchReadAt: at("2026-09-27T12:00:00Z"),
  ...over,
});

describe("prKeyOf and blankOutcome", () => {
  it("keys a pull request in lower case", () => {
    expect(prKeyOf("github", "Acme/App", 5)).toBe("github:acme/app#5");
  });

  it("gives a run with no pull request the none key and no pull request fields", () => {
    expect(blankOutcome("arun_x1", "ledger", null)).toMatchObject({
      prKey: "none",
      provider: null,
      repository: null,
      number: null,
      prState: null,
      merged: false,
      reverted: false,
    });
  });

  it("lower-cases the repository of a pull request row", () => {
    expect(blankOutcome("tse_a1", "tacho", pr)).toMatchObject({
      prKey: "github:acme/app#5",
      repository: "acme/app",
      url: "https://github.com/Acme/App/pull/5",
    });
  });
});

describe("withStateRead", () => {
  const blank = blankOutcome("tse_a1", "tacho", pr);

  it("records a merged pull request with its merge time as its close time", () => {
    const row = withStateRead(
      blank,
      read({
        state: "merged",
        mergedAt: at("2026-09-27T09:30:00Z"),
        mergeCommitSha: SHA_M,
      }),
    );
    expect(row).toMatchObject({
      prState: "merged",
      prStateReadAt: at("2026-09-27T10:00:00Z"),
      merged: true,
      mergedAt: at("2026-09-27T09:30:00Z"),
      closedAt: at("2026-09-27T09:30:00Z"),
      mergeCommitSha: SHA_M,
    });
  });

  it("takes a delivery's close time for a pull request closed without merging", () => {
    const row = withStateRead(
      blank,
      read({ state: "closed", closedAt: at("2026-09-27T09:45:00Z") }),
    );
    expect(row).toMatchObject({
      prState: "closed",
      merged: false,
      closedAt: at("2026-09-27T09:45:00Z"),
      mergedAt: null,
      mergeCommitSha: null,
    });
  });

  it("takes the forge's update time on the first read that finds it closed, and keeps it after", () => {
    const first = withStateRead(blank, read({ state: "closed" }));
    expect(first.closedAt).toEqual(at("2026-09-27T09:59:00Z"));
    const later = withStateRead(
      first,
      read({
        state: "closed",
        readAt: at("2026-09-27T11:00:00Z"),
        sourceUpdatedAt: at("2026-09-27T10:30:00Z"),
      }),
    );
    expect(later.closedAt).toEqual(at("2026-09-27T09:59:00Z"));
  });

  it("clears the close time when a pull request reopens", () => {
    const closed = withStateRead(blank, read({ state: "closed" }));
    const reopened = withStateRead(
      closed,
      read({ readAt: at("2026-09-27T11:00:00Z"), sourceUpdatedAt: at("2026-09-27T10:59:00Z") }),
    );
    expect(reopened).toMatchObject({ prState: "open", closedAt: null });
  });

  it("ignores a read older than the state the row holds", () => {
    const merged = withStateRead(
      blank,
      read({ state: "merged", mergedAt: at("2026-09-27T09:30:00Z") }),
    );
    const stale = read({
      state: "open",
      readAt: at("2026-09-27T11:00:00Z"),
      sourceUpdatedAt: at("2026-09-27T09:00:00Z"),
    });
    expect(withStateRead(merged, stale)).toBe(merged);
  });

  it("keeps a state GitHub dated against a later read that carries no GitHub time", () => {
    const merged = withStateRead(
      blank,
      read({ state: "merged", mergedAt: at("2026-09-27T09:30:00Z") }),
    );
    const undated = read({
      state: "open",
      readAt: at("2026-09-27T11:00:00Z"),
      sourceUpdatedAt: null,
    });
    expect(withStateRead(merged, undated)).toBe(merged);
  });

  it("takes a dated read over an undated state, and the later read between two undated states", () => {
    const undated = withStateRead(
      blank,
      read({ readAt: at("2026-09-27T10:00:00Z"), sourceUpdatedAt: null }),
    );
    const older = read({
      state: "closed",
      readAt: at("2026-09-27T09:00:00Z"),
      sourceUpdatedAt: null,
    });
    expect(withStateRead(undated, older)).toBe(undated);
    const later = read({
      state: "closed",
      readAt: at("2026-09-27T11:00:00Z"),
      sourceUpdatedAt: null,
    });
    expect(withStateRead(undated, later).prState).toBe("closed");
    const dated = read({
      state: "closed",
      readAt: at("2026-09-27T09:00:00Z"),
      sourceUpdatedAt: at("2026-09-27T08:00:00Z"),
    });
    expect(withStateRead(undated, dated)).toMatchObject({
      prState: "closed",
      sourceUpdatedAt: at("2026-09-27T08:00:00Z"),
    });
  });

  it("never moves the read time back when a later read reports an older record", () => {
    const row = withStateRead(blank, read({ readAt: at("2026-09-27T12:00:00Z") }));
    const again = withStateRead(row, read({ readAt: at("2026-09-27T08:00:00Z") }));
    expect(again.prStateReadAt).toEqual(at("2026-09-27T12:00:00Z"));
  });

  it("clears the CI state when the head commit moves", () => {
    const withCi = withCiRead(withStateRead(blank, read()), {
      state: "failed",
      headSha: SHA_A,
      readAt: at("2026-09-27T10:00:00Z"),
    });
    expect(withCi.ciState).toBe("failed");
    const moved = withStateRead(
      withCi,
      read({
        headSha: SHA_B,
        readAt: at("2026-09-27T11:00:00Z"),
        sourceUpdatedAt: at("2026-09-27T10:59:00Z"),
      }),
    );
    expect(moved).toMatchObject({ headSha: SHA_B, ciState: null, ciReadAt: null });
  });
});

describe("withCiRead", () => {
  it("ignores checks of a commit that is not the head", () => {
    const row = withStateRead(blankOutcome("tse_a1", "tacho", pr), read());
    expect(
      withCiRead(row, { state: "passed", headSha: SHA_B, readAt: at("2026-09-27T10:00:00Z") }),
    ).toBe(row);
  });
});

describe("withRevert", () => {
  it("keeps the first revert", () => {
    const first = withRevert(settled(), {
      by: "github:acme/app#9",
      at: at("2026-09-27T13:00:00Z"),
      readAt: at("2026-09-27T13:00:05Z"),
    });
    const second = withRevert(first, {
      by: "github:acme/app#10",
      at: at("2026-09-27T14:00:00Z"),
      readAt: at("2026-09-27T14:00:05Z"),
    });
    expect(second).toMatchObject({ reverted: true, revertedBy: "github:acme/app#9" });
  });
});

describe("needsForgeRead", () => {
  // The day after the `settled` row's close.
  const NOW = at("2026-09-28T10:00:00Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const closedDaysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

  it("reads a row never written, and an open pull request", () => {
    expect(needsForgeRead(undefined, NOW)).toBe(true);
    expect(needsForgeRead(settled({ prState: "open", merged: false }), NOW)).toBe(true);
  });

  it("reads again while CI is pending or unread", () => {
    expect(needsForgeRead(settled({ ciState: "pending" }), NOW)).toBe(true);
    expect(needsForgeRead(settled({ ciState: null }), NOW)).toBe(true);
  });

  it("reads the head branch again until an hour after the close", () => {
    const soon = new Date(at("2026-09-27T10:00:00Z").getTime() + HEAD_BRANCH_SETTLE_MS - 1);
    expect(needsForgeRead(settled({ headBranchReadAt: soon }), NOW)).toBe(true);
    expect(needsForgeRead(settled(), NOW)).toBe(false);
  });

  it("stops reading a pull request 14 days after it closed, whatever its CI or branch reads say", () => {
    expect(OUTCOME_SETTLE_DAYS).toBe(14);
    const closedAt = closedDaysAgo(OUTCOME_SETTLE_DAYS);
    const unsettled = {
      closedAt,
      ciState: "pending" as const,
      headBranchReadAt: null,
    };
    expect(
      needsForgeRead(settled({ ...unsettled, mergedAt: closedAt }), NOW),
    ).toBe(false);
    expect(
      needsForgeRead(
        settled({
          ...unsettled,
          prState: "closed",
          merged: false,
          mergedAt: null,
          ciState: null,
        }),
        NOW,
      ),
    ).toBe(false);
    // A day short of the window, the same rows are still read.
    const recent = closedDaysAgo(OUTCOME_SETTLE_DAYS - 1);
    expect(
      needsForgeRead(
        settled({ ...unsettled, closedAt: recent, mergedAt: recent }),
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps reading an open pull request however old, and a row whose state was never read", () => {
    const old = closedDaysAgo(20);
    expect(
      needsForgeRead(
        settled({ prState: "open", merged: false, mergedAt: null, closedAt: old }),
        NOW,
      ),
    ).toBe(true);
    expect(
      needsForgeRead(settled({ prState: null, merged: false, closedAt: old }), NOW),
    ).toBe(true);
  });
});

describe("ciStateOf", () => {
  it("maps each verdict", () => {
    expect(ciStateOf("passing")).toBe("passed");
    expect(ciStateOf("failing")).toBe("failed");
    expect(ciStateOf("pending")).toBe("pending");
    expect(ciStateOf("unknown")).toBe("none");
    expect(ciStateOf("neutral")).toBe("none");
  });
});

describe("ciStateOfRead", () => {
  it("maps a complete read as ciStateOf does", () => {
    expect(ciStateOfRead("passing", true)).toBe("passed");
    expect(ciStateOfRead("neutral", true)).toBe("none");
  });

  it("reads a partial read as pending unless a check it read failed", () => {
    expect(ciStateOfRead("passing", false)).toBe("pending");
    expect(ciStateOfRead("neutral", false)).toBe("pending");
    expect(ciStateOfRead("unknown", false)).toBe("pending");
    expect(ciStateOfRead("pending", false)).toBe("pending");
    expect(ciStateOfRead("failing", false)).toBe("failed");
  });
});

describe("revertTargetsOf", () => {
  it("reads the body GitHub's revert button writes", () => {
    expect(revertTargetsOf("Reverts Acme/App#5", "acme/app")).toEqual([
      { repository: "acme/app", number: 5 },
    ]);
  });

  it("reads a bare number as the body's own repository, once each", () => {
    expect(revertTargetsOf("Reverts #7\n\nreverts #7 and Reverts other/lib#2", "acme/app")).toEqual([
      { repository: "acme/app", number: 7 },
      { repository: "other/lib", number: 2 },
    ]);
  });

  it("finds nothing in a body that only mentions a pull request", () => {
    expect(revertTargetsOf("Follows up #5", "acme/app")).toEqual([]);
    expect(revertTargetsOf(null, "acme/app")).toEqual([]);
  });
});

describe("revertedShasOf and repositoryOfCommitUrl", () => {
  it("reads the line git revert writes", () => {
    expect(
      revertedShasOf(`Revert "Add x"\n\nThis reverts commit ${SHA_M.toUpperCase()}.`),
    ).toEqual([SHA_M]);
    expect(revertedShasOf("Add x")).toEqual([]);
  });

  it("reads owner/repo from a commit URL", () => {
    expect(repositoryOfCommitUrl(`https://github.com/Acme/App/commit/${SHA_A}`)).toBe("acme/app");
    expect(repositoryOfCommitUrl("https://example.com/acme/app/commit/abc1234")).toBeNull();
  });
});

describe("terminal reasons", () => {
  it("prefers the harness's reason, then the close reason, then a settled outcome", () => {
    expect(tachoTerminalReason({ terminalReason: "max_turns", endReason: "exit", outcome: "failed" })).toBe("max_turns");
    expect(tachoTerminalReason({ terminalReason: null, endReason: "exit", outcome: "failed" })).toBe("exit");
    expect(tachoTerminalReason({ terminalReason: null, endReason: null, outcome: "failed" })).toBe("failed");
    expect(tachoTerminalReason({ terminalReason: null, endReason: null, outcome: "running" })).toBeNull();
  });

  it("reads a ledger seal's reason code, else its status", () => {
    expect(ledgerTerminalReason({ reasonCode: "budget_exhausted", terminalStatus: "failed" })).toBe("budget_exhausted");
    expect(ledgerTerminalReason({ reasonCode: null, terminalStatus: "succeeded" })).toBe("succeeded");
    expect(ledgerTerminalReason(null)).toBeNull();
  });
});

describe("outcomeDeliveryOf", () => {
  const readAt = at("2026-09-27T12:00:00Z");
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 9,
    state: "closed",
    merged: true,
    merged_at: "2026-09-27T11:00:00Z",
    closed_at: "2026-09-27T11:00:00Z",
    merge_commit_sha: SHA_M,
    html_url: "https://github.com/Acme/App/pull/9",
    body: "Reverts Acme/App#5",
    updated_at: "2026-09-27T11:00:01Z",
    base: { ref: "main", repo: { full_name: "Acme/App" } },
    head: { ref: "revert-5-feat/x", sha: SHA_B },
    ...over,
  });

  it("reads a merged pull request delivery", () => {
    expect(outcomeDeliveryOf("pull_request", pull(), readAt)).toEqual({
      kind: "pull_request",
      repository: "acme/app",
      number: 9,
      url: "https://github.com/Acme/App/pull/9",
      body: "Reverts Acme/App#5",
      state: "merged",
      readAt,
      closedAt: at("2026-09-27T11:00:00Z"),
      mergedAt: at("2026-09-27T11:00:00Z"),
      mergeCommitSha: SHA_M,
      baseRef: "main",
      headRef: "revert-5-feat/x",
      headSha: SHA_B,
      sourceUpdatedAt: at("2026-09-27T11:00:01Z"),
    });
  });

  it("reads a merged pull request from a poll, which carries merged_at and no merged flag", () => {
    const polled = pull({ merged: undefined });
    expect(outcomeDeliveryOf("pull_request", polled, readAt)).toMatchObject({
      state: "merged",
      mergedAt: at("2026-09-27T11:00:00Z"),
    });
  });

  it("reads a pull request closed without merging, with GitHub's close time", () => {
    const out = outcomeDeliveryOf(
      "pull_request",
      pull({ merged: false, merged_at: null, closed_at: "2026-09-27T10:30:00Z" }),
      readAt,
    );
    expect(out).toMatchObject({
      state: "closed",
      closedAt: at("2026-09-27T10:30:00Z"),
      mergedAt: null,
      mergeCommitSha: null,
    });
  });

  it("reads an open pull request and drops its test merge commit", () => {
    const out = outcomeDeliveryOf(
      "pull_request",
      pull({ state: "open", merged: false, merged_at: null, closed_at: null }),
      readAt,
    );
    expect(out).toMatchObject({ state: "open", closedAt: null, mergeCommitSha: null });
  });

  it("reads a pushed commit", () => {
    const out = outcomeDeliveryOf(
      "commit",
      {
        sha: SHA_B,
        html_url: `https://github.com/Acme/App/commit/${SHA_B}`,
        git_branch: "main",
        commit: {
          message: `Revert "Add x"\n\nThis reverts commit ${SHA_M}.`,
          author: { name: "a", email: "a@example.com", date: "2026-09-27T11:30:00Z" },
        },
      },
      readAt,
    );
    expect(out).toEqual({
      kind: "commit",
      repository: "acme/app",
      sha: SHA_B,
      branch: "main",
      message: `Revert "Add x"\n\nThis reverts commit ${SHA_M}.`,
      at: at("2026-09-27T11:30:00Z"),
      readAt,
    });
  });

  it("skips any other record, and a payload it cannot read", () => {
    expect(outcomeDeliveryOf("issue", pull(), readAt)).toBeNull();
    expect(outcomeDeliveryOf("pull_request", { number: 9 }, readAt)).toBeNull();
    expect(outcomeDeliveryOf("commit", { sha: SHA_B }, readAt)).toBeNull();
  });
});

describe("revertPlanOf", () => {
  const readAt = at("2026-09-27T12:00:00Z");
  const delivery = (over: Record<string, unknown> = {}) => {
    const out = outcomeDeliveryOf(
      "pull_request",
      {
        number: 9,
        state: "closed",
        merged: true,
        merged_at: "2026-09-27T11:00:00Z",
        closed_at: "2026-09-27T11:00:00Z",
        body: "Reverts acme/app#5",
        updated_at: "2026-09-27T11:00:01Z",
        base: { ref: "main", repo: { full_name: "acme/app" } },
        head: { ref: "revert-5", sha: SHA_B },
        ...over,
      },
      readAt,
    );
    if (out === null) throw new Error("fixture did not parse");
    return out;
  };

  it("marks the pull request a merged revert names", () => {
    expect(revertPlanOf(delivery())).toEqual({
      kind: "pull_requests",
      targets: [{ repository: "acme/app", number: 5 }],
      mark: { by: "github:acme/app#9", at: at("2026-09-27T11:00:00Z"), readAt },
    });
  });

  it("marks nothing while the revert is open, or when it closes unmerged", () => {
    expect(
      revertPlanOf(delivery({ state: "open", merged: false, merged_at: null, closed_at: null })),
    ).toBeNull();
    expect(revertPlanOf(delivery({ merged: false, merged_at: null }))).toBeNull();
  });

  it("never marks a pull request as its own revert", () => {
    expect(revertPlanOf(delivery({ body: "Reverts #9" }))).toBeNull();
  });

  it("marks merge commits a pushed revert commit names, on the branch it landed on", () => {
    const commit = outcomeDeliveryOf(
      "commit",
      {
        sha: SHA_B,
        html_url: `https://github.com/acme/app/commit/${SHA_B}`,
        git_branch: "main",
        commit: {
          message: `Revert "Add x"\n\nThis reverts commit ${SHA_M}.`,
          author: { date: "2026-09-27T11:30:00Z" },
        },
      },
      readAt,
    );
    if (commit === null) throw new Error("fixture did not parse");
    expect(revertPlanOf(commit)).toEqual({
      kind: "merge_commits",
      repository: "acme/app",
      shas: [SHA_M],
      branch: "main",
      mark: { by: `github:acme/app@${SHA_B}`, at: at("2026-09-27T11:30:00Z"), readAt },
    });
  });
});

describe("revertEvidenceOf", () => {
  const mark = {
    by: "github:acme/app#9",
    at: at("2026-09-27T11:00:00Z"),
    readAt: at("2026-09-27T12:00:00Z"),
  };

  it("keeps one revert per pull request a plan names, with no commit or branch", () => {
    expect(
      revertEvidenceOf({
        kind: "pull_requests",
        targets: [
          { repository: "Acme/App", number: 5 },
          { repository: "acme/lib", number: 2 },
        ],
        mark,
      }),
    ).toEqual([
      { repository: "acme/app", number: 5, mergeCommitSha: null, branch: null, mark },
      { repository: "acme/lib", number: 2, mergeCommitSha: null, branch: null, mark },
    ]);
  });

  it("keeps one revert per merge commit a plan names, with the branch it landed on", () => {
    expect(
      revertEvidenceOf({
        kind: "merge_commits",
        repository: "Acme/App",
        shas: [SHA_M, SHA_A],
        branch: "main",
        mark,
      }),
    ).toEqual([
      { repository: "acme/app", number: null, mergeCommitSha: SHA_M, branch: "main", mark },
      { repository: "acme/app", number: null, mergeCommitSha: SHA_A, branch: "main", mark },
    ]);
  });
});

describe("withStoredReverts", () => {
  const mark = (by: string, readAt: string) => ({
    by,
    at: at("2026-09-27T11:00:00Z"),
    readAt: at(readAt),
  });
  const byNumber = (
    number: number,
    by = "github:acme/app#9",
    readAt = "2026-09-27T12:00:00Z",
    repository = "acme/app",
  ): RevertEvidence => ({
    repository,
    number,
    mergeCommitSha: null,
    branch: null,
    mark: mark(by, readAt),
  });
  const byCommit = (sha: string, branch: string | null): RevertEvidence => ({
    repository: "acme/app",
    number: null,
    mergeCommitSha: sha,
    branch,
    mark: mark(`github:acme/app@${SHA_B}`, "2026-09-27T12:00:00Z"),
  });

  it("marks the row a kept revert names by number", () => {
    expect(withStoredReverts(settled(), [byNumber(5)])).toMatchObject({
      reverted: true,
      revertedBy: "github:acme/app#9",
      revertedAt: at("2026-09-27T11:00:00Z"),
      revertedReadAt: at("2026-09-27T12:00:00Z"),
    });
  });

  it("leaves the row alone when no kept revert names it", () => {
    const row = settled();
    expect(withStoredReverts(row, [byNumber(6)])).toBe(row);
    expect(
      withStoredReverts(row, [byNumber(5, undefined, undefined, "acme/lib")]),
    ).toBe(row);
  });

  it("marks the row by its merge commit on the branch it merged into", () => {
    const row = settled({ mergeCommitSha: SHA_M, baseRef: "main" });
    expect(withStoredReverts(row, [byCommit(SHA_M, "main")]).reverted).toBe(true);
    expect(withStoredReverts(row, [byCommit(SHA_M, "release")])).toBe(row);
    expect(withStoredReverts(row, [byCommit(SHA_A, "main")])).toBe(row);
  });

  it("marks the row by its merge commit on any branch when the revert has none", () => {
    const row = settled({ mergeCommitSha: SHA_M, baseRef: "release" });
    expect(withStoredReverts(row, [byCommit(SHA_M, null)]).reverted).toBe(true);
  });

  it("does not match a merge commit revert to a row with no merge commit", () => {
    const row = settled({ mergeCommitSha: null, baseRef: "main" });
    expect(withStoredReverts(row, [byCommit(SHA_M, null)])).toBe(row);
  });

  it("marks the row with the revert Oxagen saw first", () => {
    const out = withStoredReverts(settled(), [
      byNumber(5, "github:acme/app#11", "2026-09-27T13:00:00Z"),
      byNumber(5, "github:acme/app#9", "2026-09-27T12:00:00Z"),
    ]);
    expect(out.revertedBy).toBe("github:acme/app#9");
  });

  it("keeps the revert a row already carries", () => {
    const row = withRevert(settled(), mark("github:acme/app#7", "2026-09-27T11:30:00Z"));
    expect(withStoredReverts(row, [byNumber(5)])).toBe(row);
  });
});
