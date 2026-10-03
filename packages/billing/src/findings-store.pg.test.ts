// writeFindings and listWorkspacesForFindings against a real Postgres: a pass
// replaces the workspace's open findings and keeps a proven finding's public
// id, a decision that commits while a pass is writing stays decided, a
// workspace whose runs stopped is still visited until its open findings go,
// the headline counts a frame two findings claim once (ADR-208), an applied
// finding with no claim rows gets its replayed claims once (#4506), and the
// pass reads the instruction lineages the proposal opener refuses (#4579).
// Runs wherever DATABASE_URL points at
// a migrated database — CI's `test` job migrates Postgres with Atlas before
// `turbo run build test:unit` and carries DATABASE_URL in turbo's globalEnv;
// a local run without one is skipped, not red. Every row it writes is removed
// in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { inAppRunTotal } from "./cost-rollup-store";
import {
  findingFingerprint,
  instructionLineage,
  type FindingClaim,
  type FindingDraft,
} from "./findings";
import {
  claimBackfill,
  CLAIMING_KINDS,
  listWorkspacesForFindings,
  readTakenLineages,
  readUnclaimedApplied,
  readUnproductiveSpend,
  runFindingsPass,
  writeClaimBackfill,
  writeFindings,
} from "./findings-store";

const enabled = Boolean(process.env.DATABASE_URL);
// On CI a missing DATABASE_URL fails the file, so a green run means these
// cases ran instead of skipping.
if (process.env.CI && !enabled) throw new Error("The findings store test needs DATABASE_URL on CI.");
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
        readFrames: async () => new Map(),
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

  it("stores each finding's claims and counts a frame two findings claim once, under the first detector", async () => {
    const own = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const RUN_A = "tse_0000000000000000000001";
    const RUN_B = "tse_0000000000000000000002";
    const frameAt = new Date("2026-09-10T10:00:00.500Z");
    const claim = (
      detector: FindingClaim["detector"],
      runId: string,
      frameKey: string,
      operatorKey: string | null,
      costMicros: bigint,
    ): FindingClaim => ({
      detector,
      runId,
      frameKey,
      frameAt,
      operatorKey,
      costMicros,
    });
    const spin = (claims: FindingClaim[]): FindingDraft => ({
      ...draft("claims"),
      kind: "spin_loops",
      level: "agent",
      fingerprint: findingFingerprint("spin_loops", "agent", "claims"),
      claims,
    });
    const recurring: FindingDraft = {
      ...draft("claims"),
      kind: "recurring_runs",
      level: "agent",
      fingerprint: findingFingerprint("recurring_runs", "agent", "claims"),
      claims: [
        claim(7, RUN_A, "2026-09-10T10:00:00.500000Z#1", "prn_a", 30_000n),
        claim(7, RUN_B, "2026-09-10T10:00:00.500000Z#0", null, 5_000n),
      ],
    };
    const window = { start: windowStart, end: windowEnd };
    const read = () =>
      withSystemDb((tx) => readUnproductiveSpend(tx, own, window));
    try {
      await writeFindings(own, windowEnd, none, [
        spin([
          claim(1, RUN_A, "2026-09-10T10:00:00.500000Z#0", "prn_a", 20_000n),
          claim(1, RUN_A, "2026-09-10T10:00:00.500000Z#1", "prn_a", 30_000n),
        ]),
        recurring,
      ]);
      expect(await read()).toEqual({
        totalMicros: 55_000n,
        operators: [
          { operatorKey: "prn_a", micros: 50_000n },
          { operatorKey: null, micros: 5_000n },
        ],
      });

      // A pass that rewrites the loop finding replaces its claims, and one
      // that no longer proves the recurring finding deletes it with its own.
      await writeFindings(own, windowEnd, none, [
        spin([
          claim(1, RUN_A, "2026-09-10T10:00:00.500000Z#0", "prn_a", 20_000n),
        ]),
      ]);
      expect(await read()).toEqual({
        totalMicros: 20_000n,
        operators: [{ operatorKey: "prn_a", micros: 20_000n }],
      });

      // A claim outside the window does not count.
      expect(
        await withSystemDb((tx) =>
          readUnproductiveSpend(tx, own, {
            start: windowStart,
            end: frameAt,
          }),
        ),
      ).toEqual({ totalMicros: 0n, operators: [] });
    } finally {
      await withSystemDb((tx) =>
        tx.delete(findings).where(eq(findings.workspaceId, own.workspaceId)),
      );
    }
  });

  it("gives an applied finding with no claim rows the claims a replay found, once, and the headline counts its frame once (#4506)", async () => {
    const own = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const RUN_A = "tse_0000000000000000000001";
    const frameKey = "2026-09-10T10:00:00.500000Z#0";
    const frameAt = new Date("2026-09-10T10:00:00.500Z");
    const fingerprint = findingFingerprint(
      "duplicate_tool_calls",
      "agent",
      "backfill",
    );
    const replayed: FindingClaim = {
      detector: 1,
      runId: RUN_A,
      frameKey,
      frameAt,
      operatorKey: "prn_a",
      costMicros: 20_000n,
    };
    const window = { start: windowStart, end: windowEnd };
    const read = () =>
      withSystemDb((tx) => readUnproductiveSpend(tx, own, window));
    try {
      // A finding applied before claims were stored: it holds no claim row.
      await writeFindings(own, windowEnd, none, [
        {
          ...draft("backfill"),
          kind: "duplicate_tool_calls",
          level: "agent",
          fingerprint,
          citedRuns: [RUN_A],
        },
      ]);
      await withSystemDb((tx) =>
        tx
          .update(findings)
          .set({
            status: "applied",
            decidedAt: new Date(),
            appliedActionId: "req_backfill",
          })
          .where(
            and(
              eq(findings.workspaceId, own.workspaceId),
              eq(findings.fingerprint, fingerprint),
            ),
          ),
      );
      expect(await read()).toEqual({ totalMicros: 0n, operators: [] });

      const unclaimed = await readUnclaimedApplied(
        own,
        CLAIMING_KINDS,
        windowStart,
      );
      expect(unclaimed).toEqual([
        {
          id: expect.any(String),
          fingerprint,
          citedRuns: [RUN_A],
          currency: "USD",
        },
      ]);
      // A finding whose window ended before the pass's window is left out.
      expect(
        await readUnclaimedApplied(
          own,
          CLAIMING_KINDS,
          new Date(windowEnd.getTime() + 1),
        ),
      ).toEqual([]);

      const backfill = claimBackfill(
        unclaimed,
        new Map([[fingerprint, [replayed]]]),
      );
      await writeClaimBackfill(own, backfill);
      // Written again, it adds nothing, and the finding no longer reads as
      // unclaimed.
      await writeClaimBackfill(own, backfill);
      expect(
        await readUnclaimedApplied(own, CLAIMING_KINDS, windowStart),
      ).toEqual([]);

      // An open finding of a later detector claims the same frame.
      await writeFindings(own, windowEnd, none, [
        {
          ...draft("backfill-recurring"),
          kind: "recurring_runs",
          level: "agent",
          fingerprint: findingFingerprint(
            "recurring_runs",
            "agent",
            "backfill-recurring",
          ),
          claims: [{ ...replayed, detector: 7 }],
        },
      ]);
      expect(await read()).toEqual({
        totalMicros: 20_000n,
        operators: [{ operatorKey: "prn_a", micros: 20_000n }],
      });
    } finally {
      await withSystemDb((tx) =>
        tx.delete(findings).where(eq(findings.workspaceId, own.workspaceId)),
      );
    }
  });

  // ADR-235, 2026-10-02 amendment. A finding names its runs as evidence, and
  // the workspace does not monitor the in-app assistant, so the pass reads
  // none of its runs. This is the predicate `readRuns` adds, read on the
  // system connection the pass uses.
  it("leaves the in-app assistant's run rows out of the pass's run read", async () => {
    const own = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const runIds = {
      chat: crypto.randomUUID(),
      apiChat: crypto.randomUUID(),
      external: crypto.randomUUID(),
    };
    const session = `tse_findings_${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = new Date("2026-09-10T12:00:00.000Z");
    const row = (runId: string, runSource: "ledger" | "tacho") => ({
      ...own,
      runId,
      runSource,
      startedAt,
      sealedAt: new Date(startedAt.getTime() + 600_000),
      steps: 1,
      modelCalls: 1,
      toolCalls: 0,
      tokens: {},
      costMicros: null,
      costBasis: null,
      breakdown: { models: [], tools: [], steps: null },
      rolledUpAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    try {
      const publicIds = await withSystemDb(async (tx) => {
        const inserted = await tx
          .insert(schema.agentRuns)
          .values([
            { id: runIds.chat, ...own, surface: "chat", spec: {} },
            { id: runIds.apiChat, ...own, surface: "api-chat", spec: {} },
            { id: runIds.external, ...own, surface: "external", spec: {} },
          ])
          .returning({
            id: schema.agentRuns.id,
            publicId: schema.agentRuns.publicId,
          });
        const byId = new Map(inserted.map((r) => [r.id, r.publicId]));
        const ids = {
          chat: byId.get(runIds.chat)!,
          apiChat: byId.get(runIds.apiChat)!,
          external: byId.get(runIds.external)!,
        };
        await tx
          .insert(schema.runTotals)
          .values([
            row(ids.chat, "ledger"),
            row(ids.apiChat, "ledger"),
            row(ids.external, "ledger"),
            row(session, "tacho"),
          ]);
        return ids;
      });
      const read = await withSystemDb((tx) =>
        tx
          .select({ runId: schema.runTotals.runId })
          .from(schema.runTotals)
          .where(
            and(
              eq(schema.runTotals.orgId, own.orgId),
              eq(schema.runTotals.workspaceId, own.workspaceId),
              sql`not ${inAppRunTotal()}`,
            ),
          ),
      );
      // A wrapped session's `tse_…` id never names an `agent_runs` row.
      expect(read.map((r) => r.runId).sort()).toEqual(
        [publicIds.external, session].sort(),
      );
    } finally {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.runTotals)
          .where(eq(schema.runTotals.workspaceId, own.workspaceId));
        await tx
          .delete(schema.agentRuns)
          .where(inArray(schema.agentRuns.id, Object.values(runIds)));
      });
    }
  });

  it("reads the workspace's repeated instruction lineages that a record or a proposal holds, in any case or state (#4579)", async () => {
    const own = {
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    const other = { orgId: own.orgId, workspaceId: crypto.randomUUID() };
    const recorded = instructionLineage("a1b2c3d4e5f6");
    const retired = instructionLineage("fedcba987654");
    const proposed = instructionLineage("0123456789ab");
    const rejected = instructionLineage("abcdef012345");
    const elsewhere = instructionLineage("111111111111");
    const proposal = (
      scope: typeof own,
      lineageId: string,
      status = "proposed",
    ) => ({
      ...scope,
      lineageId,
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      statement: "Run the tests before you commit.",
      rationale: "Runs received this instruction 3 times.",
      source: "findings_job",
      status,
    });
    try {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.steeringRecords).values([
          // The column ignores case, as the opener's own check does.
          { ...own, slug: recorded.toUpperCase(), title: "Run the tests" },
          {
            ...own,
            slug: retired,
            title: "Run the linter",
            status: "retired",
            deletedAt: new Date(),
          },
          // Another lineage family, and a slug that only contains the prefix.
          { ...own, slug: "ctx.habits.spin_loops-abc", title: "Spin loops" },
          { ...own, slug: `x.${recorded}`, title: "Not a lineage" },
        ]);
        await tx
          .insert(schema.steeringProposals)
          .values([
            proposal(own, proposed),
            proposal(own, rejected, "rejected"),
            proposal(other, elsewhere),
          ]);
      });

      expect(await readTakenLineages(own)).toEqual(
        new Set([recorded, retired, proposed, rejected]),
      );
    } finally {
      await withSystemDb(async (tx) => {
        const workspaces = [own.workspaceId, other.workspaceId];
        await tx
          .delete(schema.steeringRecords)
          .where(inArray(schema.steeringRecords.workspaceId, workspaces));
        await tx
          .delete(schema.steeringProposals)
          .where(inArray(schema.steeringProposals.workspaceId, workspaces));
      });
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
