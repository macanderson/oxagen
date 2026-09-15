// writeFindings and listWorkspacesForFindings against a real Postgres: a pass
// replaces the workspace's open findings and keeps a proven finding's public
// id, a decision that commits while a pass is writing stays decided, and a
// workspace whose runs stopped is still visited until its open findings go. Runs wherever DATABASE_URL points at
// a migrated database — CI's `test` job migrates Postgres with Atlas before
// `turbo run build test:unit` and carries DATABASE_URL in turbo's globalEnv;
// a local run without one is skipped, not red. Every row it writes is removed
// in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { findingFingerprint, type FindingDraft } from "./findings";
import {
  listWorkspacesForFindings,
  runFindingsPass,
  writeFindings,
} from "./findings-store";

const enabled = Boolean(process.env.DATABASE_URL);
const findings = schema.findings;

describe.skipIf(!enabled)("writeFindings against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const windowStart = new Date("2026-08-16T00:00:00.000Z");
  const windowEnd = new Date("2026-09-15T00:00:00.000Z");

  function draft(subject: string): FindingDraft {
    return {
      kind: "unpaged_results",
      level: "tool",
      subject,
      fingerprint: findingFingerprint("unpaged_results", "tool", subject),
      windowStart,
      windowEnd,
      savingMicros: 50_000n,
      currency: "USD",
      basis: "gateway_observed",
      confidence: "high",
      why: "2 calls returned more than 20,000 result tokens.",
      fix: "Page the results.",
      citedRuns: ["tse_0000000000000000000001"],
      evidence: {
        calls: 2,
        coveredCalls: 2,
        measuredTokens: 50_000,
        counterfactualTokens: 8_000,
        measuredMicros: "60000",
        counterfactualMicros: "10000",
        operatorKeys: [],
        runs: [],
      },
    };
  }

  const none = new Map<string, Date>();

  const rowsOf = (subject: string) =>
    withSystemDb((tx) =>
      tx
        .select({ publicId: findings.publicId, status: findings.status })
        .from(findings)
        .where(
          and(
            eq(findings.orgId, scope.orgId),
            eq(findings.workspaceId, scope.workspaceId),
            eq(findings.subject, subject),
          ),
        ),
    );

  afterAll(async () => {
    await withSystemDb((tx) =>
      tx.delete(findings).where(eq(findings.workspaceId, scope.workspaceId)),
    );
    await closeDatabase();
  });

  it("deletes the open findings a pass no longer proves and keeps a proven one's public id", async () => {
    await writeFindings(scope, windowEnd, none, [
      draft("kept"),
      draft("dropped"),
    ]);
    const [kept] = await rowsOf("kept");

    expect(await writeFindings(scope, windowEnd, none, [draft("kept")])).toBe(
      1,
    );

    expect(await rowsOf("kept")).toEqual([kept]);
    expect(await rowsOf("dropped")).toEqual([]);
  });

  it("leaves a finding decided while the pass waits on its row decided, with no new open row", async () => {
    await writeFindings(scope, windowEnd, none, [draft("raced")]);
    const [open] = await rowsOf("raced");
    const passStartedAt = new Date();

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let decisionWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      decisionWritten = resolve;
    });
    const decision = withSystemDb(async (tx) => {
      await tx
        .update(findings)
        .set({ status: "dismissed", decidedAt: new Date() })
        .where(eq(findings.publicId, open!.publicId));
      decisionWritten();
      await held;
    });
    await written;

    const pass = writeFindings(scope, passStartedAt, none, [draft("raced")]);
    await waitForLockWait();
    commit();
    await decision;

    expect(await pass).toBe(0);
    expect(await rowsOf("raced")).toEqual([
      { publicId: open!.publicId, status: "dismissed" },
    ]);
  });

  it("leaves a finding decided by a clock behind the pass's decided, when the decision commits after the pass read decisions", async () => {
    await writeFindings(scope, windowEnd, none, [draft("skewed")]);
    const [open] = await rowsOf("skewed");
    // The pass read decisions (none on this fingerprint) and took its start;
    // the API host stamped the dismissal a second earlier and committed after.
    const passStartedAt = new Date();
    await withSystemDb((tx) =>
      tx
        .update(findings)
        .set({
          status: "dismissed",
          decidedAt: new Date(passStartedAt.getTime() - 1_000),
        })
        .where(eq(findings.publicId, open!.publicId)),
    );

    expect(
      await writeFindings(scope, passStartedAt, none, [draft("skewed")]),
    ).toBe(0);
    expect(await rowsOf("skewed")).toEqual([
      { publicId: open!.publicId, status: "dismissed" },
    ]);
  });

  it("visits a workspace with an open finding and no runs in the window, and the pass leaves it no open finding", async () => {
    const idle = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const now = new Date();
    try {
      await writeFindings(idle, windowEnd, none, [draft("stale")]);

      expect(await listWorkspacesForFindings(now)).toContainEqual(idle);

      await runFindingsPass(idle, {
        now: () => now,
        readRuns: async () => [],
        readRootSessions: async () => new Map(),
        readToolCalls: async () => [],
        readDecisions: async () => new Map(),
        write: writeFindings,
      });
      const open = await withSystemDb((tx) =>
        tx
          .select({ id: findings.id })
          .from(findings)
          .where(
            and(
              eq(findings.workspaceId, idle.workspaceId),
              eq(findings.status, "open"),
            ),
          ),
      );
      expect(open).toEqual([]);
      expect(await listWorkspacesForFindings(now)).not.toContainEqual(idle);
    } finally {
      await withSystemDb((tx) =>
        tx.delete(findings).where(eq(findings.workspaceId, idle.workspaceId)),
      );
    }
  });
});

/** Resolve once some statement on cost.findings waits on a row lock. */
async function waitForLockWait(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await withSystemDb((tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and query ilike '%"cost"."findings"%'`,
      ),
    );
    if (row && row.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no statement on cost.findings waited on a lock");
}
