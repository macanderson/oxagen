// The run_pr_outcomes writes against a real Postgres (#4491): the refresh's
// upsert keeps a state a delivery dated, and `cost.run_pr_reverts` keeps a
// revert whose row does not exist yet, once. Runs wherever DATABASE_URL points at a
// migrated database (CI's `test` job); a local run without one is skipped,
// not red. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  blankOutcome,
  type CommitDelivery,
  type OutcomeRow,
  type PullRequestDelivery,
} from "./run-pr-outcomes";
import {
  applyOutcomeDelivery,
  pruneRevertEvidence,
  readOutcomeRows,
  readRevertEvidence,
  saveOutcomeRows,
  saveRevertEvidence,
} from "./run-pr-outcomes-store";

const enabled = Boolean(process.env.DATABASE_URL);
const outcomes = schema.runPrOutcomes;
const reverts = schema.runPrReverts;

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
        branch: null,
        mark: {
          by: `github:acme/app${tag}#19`,
          at: at("2026-09-27T10:59:00Z"),
          readAt: at("2026-09-27T11:00:00Z"),
        },
      },
    ]);
  });

  it("keeps one merge commit revert with no branch however often it arrives", async () => {
    const reverted = "f".repeat(40);
    const commit: CommitDelivery = {
      kind: "commit",
      repository: `acme/app${tag}`,
      sha: "e".repeat(40),
      branch: null,
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
        branch: null,
        mark: {
          by: `github:acme/app${tag}@${"e".repeat(40)}`,
          at: at("2026-09-27T11:30:00Z"),
          readAt: at("2026-09-27T11:31:00Z"),
        },
      },
    ]);
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
