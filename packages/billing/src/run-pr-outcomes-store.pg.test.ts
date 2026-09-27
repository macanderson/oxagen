// The run_pr_outcomes writes against a real Postgres (#4491): the refresh's
// upsert keeps a state a delivery dated, and a revert reaches a row that did
// not exist when the revert was seen. Runs wherever DATABASE_URL points at a
// migrated database (CI's `test` job); a local run without one is skipped,
// not red. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  blankOutcome,
  type OutcomeRow,
  type PullRequestDelivery,
} from "./run-pr-outcomes";
import {
  applyOutcomeDelivery,
  readOutcomeRows,
  saveOutcomeRows,
} from "./run-pr-outcomes-store";

const enabled = Boolean(process.env.DATABASE_URL);
const outcomes = schema.runPrOutcomes;

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
});
