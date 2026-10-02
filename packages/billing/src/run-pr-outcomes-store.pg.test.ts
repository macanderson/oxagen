// The run_pr_outcomes writes against a real Postgres (#4491, #4511): the
// refresh's upsert keeps a state a delivery dated and, between two states of
// the same second, the later read; `cost.run_pr_reverts` keeps a revert whose
// row does not exist yet, once; a revert marks a row only on the branch it
// landed on; and `cost.run_pr_delivered_states` keeps a delivery that found no
// row. Runs wherever DATABASE_URL points at a migrated database (CI's `test`
// job); a local run without one is skipped, not red. Every row it writes is
// removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  blankOutcome,
  type CommitDelivery,
  type OutcomeRow,
  prKeyOf,
  type PullRequestDelivery,
  withStateRead,
} from "./run-pr-outcomes";
import {
  applyOutcomeDelivery,
  pruneRevertEvidence,
  readDeliveredStates,
  readOutcomeRows,
  readRevertEvidence,
  saveOutcomeRows,
  saveRevertEvidence,
} from "./run-pr-outcomes-store";

const enabled = Boolean(process.env.DATABASE_URL);
const outcomes = schema.runPrOutcomes;
const reverts = schema.runPrReverts;
const delivered = schema.runPrDeliveredStates;

describe.skipIf(!enabled)("run_pr_outcomes writes against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const pr = (number: number) => ({
    provider: "github" as const,
    repository: `acme/app${tag}`,
    number,
    url: `https://github.com/acme/app${tag}/pull/${number}`,
  });
  const at = (iso: string) => new Date(iso);

  const stored = async (runId: string) => {
    const [row] = await readOutcomeRows(scope, [runId]);
    return row;
  };

  /** The reverts kept for the scope this year, which leaves out the prune test's rows. */
  const kept = () => readRevertEvidence(scope, at("2026-01-01T00:00:00Z"));

  afterAll(async () => {
    await withSystemDb((tx) =>
      tx
        .delete(outcomes)
        .where(
          and(
            eq(outcomes.orgId, scope.orgId),
            eq(outcomes.workspaceId, scope.workspaceId),
          ),
        ),
    );
    await withSystemDb((tx) =>
      tx
        .delete(reverts)
        .where(
          and(
            eq(reverts.orgId, scope.orgId),
            eq(reverts.workspaceId, scope.workspaceId),
          ),
        ),
    );
    await withSystemDb((tx) =>
      tx
        .delete(delivered)
        .where(
          and(
            eq(delivered.orgId, scope.orgId),
            eq(delivered.workspaceId, scope.workspaceId),
          ),
        ),
    );
    await closeDatabase();
  });

  it("keeps a state a delivery dated when the refresh writes a row it read before the delivery", async () => {
    const runId = `tse_${tag}a1`;
    const before: OutcomeRow = {
      ...blankOutcome(runId, "tacho", pr(5)),
      prState: "open",
      prStateReadAt: at("2026-09-27T10:00:00Z"),
    };
    await saveOutcomeRows(scope, [before]);
    const delivery: PullRequestDelivery = {
      kind: "pull_request",
      repository: `acme/app${tag}`,
      number: 5,
      url: null,
      body: null,
      state: "merged",
      readAt: at("2026-09-27T11:00:00Z"),
      closedAt: at("2026-09-27T10:59:00Z"),
      mergedAt: at("2026-09-27T10:59:00Z"),
      mergeCommitSha: "c".repeat(40),
      baseRef: "main",
      headRef: "feat/x",
      headSha: "a".repeat(40),
      sourceUpdatedAt: at("2026-09-27T10:59:01Z"),
    };
    expect((await applyOutcomeDelivery(scope, delivery)).rows).toBe(1);

    // The refresh read the row before the delivery and writes it back with
    // a terminal reason and a later read time, but no GitHub time.
    const written = await saveOutcomeRows(scope, [
      {
        ...before,
        prStateReadAt: at("2026-09-27T12:00:00Z"),
        terminalReason: "completed",
        terminalReasonReadAt: at("2026-09-27T12:00:00Z"),
      },
    ]);

    expect(written).toBe(0);
    expect(await stored(runId)).toMatchObject({
      prState: "merged",
      merged: true,
      sourceUpdatedAt: at("2026-09-27T10:59:01Z"),
    });
  });

  it("orders two undated states by read time", async () => {
    const runId = `tse_${tag}b2`;
    const undated = (readAt: string, state: "open" | "closed"): OutcomeRow => ({
      ...blankOutcome(runId, "tacho", pr(6)),
      prState: state,
      prStateReadAt: at(readAt),
      closedAt: state === "closed" ? at(readAt) : null,
    });
    await saveOutcomeRows(scope, [undated("2026-09-27T10:00:00Z", "open")]);

    expect(
      await saveOutcomeRows(scope, [undated("2026-09-27T09:00:00Z", "closed")]),
    ).toBe(0);
    expect((await stored(runId))?.prState).toBe("open");

    expect(
      await saveOutcomeRows(scope, [undated("2026-09-27T11:00:00Z", "closed")]),
    ).toBe(1);
    expect((await stored(runId))?.prState).toBe("closed");
  });

  it("lets a dated state replace an undated one", async () => {
    const runId = `tse_${tag}c3`;
    await saveOutcomeRows(scope, [
      {
        ...blankOutcome(runId, "tacho", pr(7)),
        prState: "open",
        prStateReadAt: at("2026-09-27T12:00:00Z"),
      },
    ]);
    const written = await saveOutcomeRows(scope, [
      {
        ...blankOutcome(runId, "tacho", pr(7)),
        prState: "closed",
        prStateReadAt: at("2026-09-27T11:00:00Z"),
        closedAt: at("2026-09-27T10:00:00Z"),
        sourceUpdatedAt: at("2026-09-27T10:00:00Z"),
      },
    ]);
    expect(written).toBe(1);
    expect((await stored(runId))?.prState).toBe("closed");
  });

  it("keeps a revert whose pull request has no row yet, once however often it arrives", async () => {
    const delivery: PullRequestDelivery = {
      kind: "pull_request",
      repository: `acme/app${tag}`,
      number: 19,
      url: null,
      body: "Reverts #15",
      state: "merged",
      readAt: at("2026-09-27T11:00:00Z"),
      closedAt: at("2026-09-27T10:59:00Z"),
      mergedAt: at("2026-09-27T10:59:00Z"),
      mergeCommitSha: "d".repeat(40),
      baseRef: "main",
      headRef: "revert-15",
      headSha: "b".repeat(40),
      sourceUpdatedAt: at("2026-09-27T10:59:01Z"),
    };
    expect(await applyOutcomeDelivery(scope, delivery)).toEqual({
      rows: 0,
      reverted: 0,
    });
    await applyOutcomeDelivery(scope, {
      ...delivery,
      readAt: at("2026-09-27T11:05:00Z"),
    });

    expect((await kept()).filter((e) => e.number === 15)).toEqual([
      {
        repository: `acme/app${tag}`,
        number: 15,
        mergeCommitSha: null,
        branch: "main",
        mark: {
          by: `github:acme/app${tag}#19`,
          at: at("2026-09-27T10:59:00Z"),
          readAt: at("2026-09-27T11:00:00Z"),
        },
      },
    ]);
  });

  it("keeps one merge commit revert per branch however often it arrives", async () => {
    const reverted = "f".repeat(40);
    const commit: CommitDelivery = {
      kind: "commit",
      repository: `acme/app${tag}`,
      sha: "e".repeat(40),
      branch: "main",
      message: `Revert "Add y"\n\nThis reverts commit ${reverted}.`,
      at: at("2026-09-27T11:30:00Z"),
      readAt: at("2026-09-27T11:31:00Z"),
    };
    await applyOutcomeDelivery(scope, commit);
    await applyOutcomeDelivery(scope, {
      ...commit,
      readAt: at("2026-09-27T11:40:00Z"),
    });

    expect((await kept()).filter((e) => e.mergeCommitSha === reverted)).toEqual([
      {
        repository: `acme/app${tag}`,
        number: null,
        mergeCommitSha: reverted,
        branch: "main",
        mark: {
          by: `github:acme/app${tag}@${"e".repeat(40)}`,
          at: at("2026-09-27T11:30:00Z"),
          readAt: at("2026-09-27T11:31:00Z"),
        },
      },
    ]);
  });

  it("keeps the later read when the refresh writes a state with the same GitHub time", async () => {
    const runId = `tse_${tag}d4`;
    const sameSecond = at("2026-09-27T10:00:00Z");
    const merged: OutcomeRow = {
      ...blankOutcome(runId, "tacho", pr(8)),
      prState: "merged",
      prStateReadAt: at("2026-09-27T10:00:09Z"),
      merged: true,
      mergedAt: sameSecond,
      closedAt: sameSecond,
      sourceUpdatedAt: sameSecond,
    };
    expect(await saveOutcomeRows(scope, [merged])).toBe(1);

    // A closed state from the same second, read earlier, arrives last.
    const closedReadEarlier: OutcomeRow = {
      ...merged,
      prState: "closed",
      prStateReadAt: at("2026-09-27T10:00:02Z"),
      merged: false,
      mergedAt: null,
    };
    expect(await saveOutcomeRows(scope, [closedReadEarlier])).toBe(0);
    expect(await stored(runId)).toMatchObject({
      prState: "merged",
      prStateReadAt: at("2026-09-27T10:00:09Z"),
    });

    // The same row written again, at the same read time, still writes, so the
    // refresh can add a terminal reason to a state that did not change.
    expect(
      await saveOutcomeRows(scope, [
        {
          ...merged,
          terminalReason: "completed",
          terminalReasonReadAt: at("2026-09-27T12:00:00Z"),
        },
      ]),
    ).toBe(1);
    expect((await stored(runId))?.terminalReason).toBe("completed");
  });

  it("keeps the later read when a delivery carries the same GitHub time as the row", async () => {
    const runId = `tse_${tag}e5`;
    const sameSecond = at("2026-09-27T10:00:00Z");
    await saveOutcomeRows(scope, [
      {
        ...blankOutcome(runId, "tacho", pr(9)),
        prState: "merged",
        prStateReadAt: at("2026-09-27T10:00:09Z"),
        merged: true,
        mergedAt: sameSecond,
        closedAt: sameSecond,
        sourceUpdatedAt: sameSecond,
      },
    ]);
    const closed: PullRequestDelivery = {
      kind: "pull_request",
      repository: `acme/app${tag}`,
      number: 9,
      url: null,
      body: null,
      state: "closed",
      readAt: at("2026-09-27T10:00:02Z"),
      closedAt: sameSecond,
      mergedAt: null,
      mergeCommitSha: null,
      baseRef: "main",
      headRef: "feat/x",
      headSha: "a".repeat(40),
      sourceUpdatedAt: sameSecond,
    };
    expect((await applyOutcomeDelivery(scope, closed)).rows).toBe(0);
    expect((await stored(runId))?.prState).toBe("merged");
  });

  describe("a revert lands on one branch", () => {
    const merged = (runId: string, number: number, baseRef: string, sha: string): OutcomeRow => ({
      ...blankOutcome(runId, "tacho", pr(number)),
      prState: "merged",
      prStateReadAt: at("2026-09-27T10:00:00Z"),
      merged: true,
      mergedAt: at("2026-09-27T09:00:00Z"),
      closedAt: at("2026-09-27T09:00:00Z"),
      mergeCommitSha: sha,
      baseRef,
      sourceUpdatedAt: at("2026-09-27T09:00:01Z"),
    });
    const revertPull = (number: number, target: number, baseRef: string): PullRequestDelivery => ({
      kind: "pull_request",
      repository: `acme/app${tag}`,
      number,
      url: null,
      body: `Reverts acme/app${tag}#${target}`,
      state: "merged",
      readAt: at("2026-09-27T11:00:00Z"),
      closedAt: at("2026-09-27T10:59:00Z"),
      mergedAt: at("2026-09-27T10:59:00Z"),
      mergeCommitSha: "9".repeat(40),
      baseRef,
      headRef: `revert-${target}`,
      headSha: "8".repeat(40),
      sourceUpdatedAt: at("2026-09-27T10:59:01Z"),
    });

    it("does not mark a pull request merged into main by a revert merged into release", async () => {
      const runId = `tse_${tag}f6`;
      await saveOutcomeRows(scope, [merged(runId, 50, "main", "1".repeat(40))]);
      expect((await applyOutcomeDelivery(scope, revertPull(51, 50, "release"))).reverted).toBe(0);
      expect((await stored(runId))?.reverted).toBe(false);
    });

    it("marks a pull request merged into main by a revert merged into main", async () => {
      const runId = `tse_${tag}g7`;
      await saveOutcomeRows(scope, [merged(runId, 52, "main", "2".repeat(40))]);
      expect((await applyOutcomeDelivery(scope, revertPull(53, 52, "main"))).reverted).toBe(1);
      expect(await stored(runId)).toMatchObject({
        reverted: true,
        revertedBy: `github:acme/app${tag}#53`,
      });
    });

    it("does not mark a release pull request by a revert commit with no branch", async () => {
      const runId = `tse_${tag}h8`;
      const sha = "3".repeat(40);
      await saveOutcomeRows(scope, [merged(runId, 54, "release", sha)]);
      const commit: CommitDelivery = {
        kind: "commit",
        repository: `acme/app${tag}`,
        sha: "4".repeat(40),
        branch: null,
        message: `Revert "Add z"\n\nThis reverts commit ${sha}.`,
        at: at("2026-09-27T11:30:00Z"),
        readAt: at("2026-09-27T11:31:00Z"),
      };
      expect(await applyOutcomeDelivery(scope, commit)).toEqual({ rows: 0, reverted: 0 });
      expect((await stored(runId))?.reverted).toBe(false);
      expect((await kept()).some((e) => e.mergeCommitSha === sha)).toBe(false);
    });
  });

  describe("a state delivered before the first row", () => {
    // The kept states are pruned 31 days after they are read, so these are
    // read near the time the test runs.
    const MINUTE = 60_000;
    const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);
    const state = (
      number: number,
      over: Partial<PullRequestDelivery>,
    ): PullRequestDelivery => ({
      kind: "pull_request",
      repository: `acme/app${tag}`,
      number,
      url: null,
      body: null,
      state: "open",
      readAt: ago(10),
      closedAt: null,
      mergedAt: null,
      mergeCommitSha: null,
      baseRef: "main",
      headRef: "feat/x",
      headSha: "a".repeat(40),
      sourceUpdatedAt: ago(11),
      ...over,
    });
    const key = (number: number) => prKeyOf("github", `acme/app${tag}`, number);

    it("keeps a reopened state that found no row, and the refresh writes the row open", async () => {
      // The refresh read the pull request closed. It reopened, and its
      // delivery landed before the refresh wrote the run's first row.
      const reopened = state(60, { readAt: ago(5), sourceUpdatedAt: ago(6) });
      expect(await applyOutcomeDelivery(scope, reopened)).toEqual({ rows: 0, reverted: 0 });
      const [kept60] = await readDeliveredStates(scope, [key(60)]);
      expect(kept60).toMatchObject({ prKey: key(60), state: { state: "open" } });

      const runId = `arun_${tag}i9`;
      const closedSnapshot: OutcomeRow = {
        ...blankOutcome(runId, "ledger", pr(60)),
        prState: "closed",
        prStateReadAt: ago(4),
        closedAt: ago(30),
        sourceUpdatedAt: ago(30),
      };
      // The refresh folds the kept state into the row before it writes it.
      const row = kept60 ? withStateRead(closedSnapshot, kept60.state) : closedSnapshot;
      await saveOutcomeRows(scope, [row]);
      expect(await stored(runId)).toMatchObject({ prState: "open", closedAt: null });
    });

    it("keeps the newest state, and the later read of the same second", async () => {
      const newest = state(61, { state: "closed", closedAt: ago(20), readAt: ago(19), sourceUpdatedAt: ago(20) });
      await applyOutcomeDelivery(scope, newest);
      // An older state delivered late changes nothing.
      await applyOutcomeDelivery(scope, state(61, { readAt: ago(2), sourceUpdatedAt: ago(40) }));
      // A state of the same second read earlier changes nothing either.
      await applyOutcomeDelivery(
        scope,
        state(61, { readAt: ago(25), sourceUpdatedAt: newest.sourceUpdatedAt }),
      );
      const [kept61] = await readDeliveredStates(scope, [key(61)]);
      expect(kept61?.state).toMatchObject({ state: "closed", readAt: newest.readAt });
      // A newer one replaces it.
      await applyOutcomeDelivery(scope, state(61, { readAt: ago(1), sourceUpdatedAt: ago(1) }));
      const [later] = await readDeliveredStates(scope, [key(61)]);
      expect(later?.state.state).toBe("open");
    });

    it("deletes the workspace's states read more than 31 days ago", async () => {
      await applyOutcomeDelivery(
        scope,
        state(62, { readAt: ago(32 * 24 * 60), sourceUpdatedAt: ago(32 * 24 * 60) }),
      );
      await applyOutcomeDelivery(scope, state(63, {}));
      const left = await readDeliveredStates(scope, [key(62), key(63)]);
      expect(left.map((d) => d.prKey)).toEqual([key(63)]);
    });
  });

  it("prunes a revert Oxagen saw before the cutoff and keeps a later one", async () => {
    const old = {
      repository: `acme/app${tag}`,
      number: 31,
      mergeCommitSha: null,
      branch: null,
      mark: {
        by: `github:acme/app${tag}#32`,
        at: at("2000-01-01T00:00:00Z"),
        readAt: at("2000-01-01T00:00:00Z"),
      },
    };
    const recent = {
      ...old,
      number: 33,
      mark: { ...old.mark, readAt: at("2026-09-27T12:00:00Z") },
    };
    expect(await saveRevertEvidence(scope, [old, recent])).toBe(2);

    expect(await pruneRevertEvidence(at("2000-01-02T00:00:00Z"))).toBeGreaterThanOrEqual(1);

    const left = await readRevertEvidence(scope, at("1999-01-01T00:00:00Z"));
    expect(left.some((e) => e.number === 31)).toBe(false);
    expect(left.some((e) => e.number === 33)).toBe(true);
  });
});
