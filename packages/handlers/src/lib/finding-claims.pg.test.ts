// The finding-claim reads behind Wasted spend and the Findings hero against a
// real Postgres (#5294). `readCauseClaims` returns the calls open and applied
// findings claim in the window, each with its finding's kind and basis, and
// leaves out a dismissed finding's calls, a call outside the window, and a
// call of the in-app assistant's runs. `countFindingsOutside` counts the open
// findings that claim calls and none in the window. Runs wherever
// DATABASE_URL points at a migrated database (CI's `test` job). A local run
// without one is skipped. Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countFindingsOutside, readCauseClaims } from "./finding-claims";

const enabled = Boolean(process.env.DATABASE_URL);
const findings = schema.findings;
const claims = schema.findingClaims;
const totals = schema.runTotals;
const runs = schema.agentRuns;

describe.skipIf(!enabled)("the finding-claim reads against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const window = {
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-10-02T00:00:00.000Z"),
  };
  const inside = new Date("2026-10-01T05:00:00.000Z");
  const before = new Date("2026-09-20T05:00:00.000Z");
  const runA = `tse_claimsa${tag}00000000000`;
  const runB = `tse_claimsb${tag}00000000000`;
  const runC = `tse_claimsc${tag}00000000000`;
  const assistantId = crypto.randomUUID();
  let assistant = "";
  const ids: Record<string, string> = {};

  /** A pass window that ended before the window under test began. */
  const earlier = {
    windowStart: new Date("2026-08-28T00:00:00.000Z"),
    windowEnd: new Date("2026-09-27T00:00:00.000Z"),
  };

  /** One finding row, open unless `status` says otherwise. */
  const finding = (
    name: string,
    kind: string,
    status: "open" | "applied" | "dismissed" = "open",
    basis = "client_attested",
    span = {
      windowStart: new Date("2026-09-01T00:00:00.000Z"),
      windowEnd: new Date("2026-10-02T00:00:00.000Z"),
    },
  ) => ({
    ...scope,
    kind,
    level: "workspace",
    subject: `${name}-${tag}`,
    fingerprint: `${kind}|workspace|${name}-${tag}`,
    ...span,
    estimatedSavingMicros: 1_000n,
    savingBasis: basis,
    confidence: "high",
    why: "Why.",
    fix: "Fix.",
    citedRuns: [runA],
    citedFrames: {},
    status,
    detectedAt: new Date("2026-10-01T06:00:00.000Z"),
    decidedAt: status === "open" ? null : new Date("2026-10-01T07:00:00.000Z"),
    appliedActionId: status === "applied" ? `req_${tag}` : null,
  });

  /** One claimed call. */
  const claim = (
    findingName: string,
    detector: number,
    runId: string,
    frameKey: string,
    frameAt: Date,
    costMicros: bigint,
  ) => ({
    ...scope,
    findingId: ids[findingName]!,
    detector,
    runId,
    frameKey,
    frameAt,
    operatorKey: null,
    costMicros,
  });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      const [run] = await tx
        .insert(runs)
        .values({ id: assistantId, ...scope, surface: "chat", spec: {} })
        .returning({ publicId: runs.publicId });
      assistant = run!.publicId;
      // The in-app filter reads the run's rollup row.
      await tx.insert(totals).values({
        ...scope,
        runId: assistant,
        runSource: "ledger",
        startedAt: before,
        sealedAt: inside,
        steps: 1,
        modelCalls: 1,
        toolCalls: 0,
        tokens: {},
        costMicros: null,
        costBasis: null,
        breakdown: { models: [], tools: [], steps: null },
        rolledUpAt: inside,
      });
      const rows = await tx
        .insert(findings)
        .values([
          // Claims a call inside the window and one before it.
          finding("spin", "spin_loops"),
          // Applied, and claims the same call as the spin loop.
          finding("dupe", "duplicate_tool_calls", "applied", "gateway_observed"),
          // Dismissed: its call counts nowhere.
          finding("recurring", "recurring_runs", "dismissed"),
          // Claims a call of the in-app assistant's run.
          finding("retry", "retry_loops"),
          // Claims a call before the window only.
          finding("nooutcome", "spend_with_no_outcome"),
          // Claims nothing, and its window overlaps the one under test.
          finding("shell", "repeated_shell_commands"),
          // Claims nothing, written before claims existed, by a pass whose
          // window ended before the one under test.
          finding("legacy", "duplicate_tool_calls", "open", "client_attested", earlier),
          // A kind that claims no call, over the same earlier window.
          finding("carry", "unpaged_results", "open", "client_attested", earlier),
        ])
        .returning({ id: findings.id, subject: findings.subject });
      for (const row of rows) ids[row.subject.replace(`-${tag}`, "")] = row.id;
      await tx
        .insert(claims)
        .values([
          claim("spin", 1, runA, "a#1", inside, 700n),
          claim("spin", 1, runA, "a#0", before, 100n),
          claim("dupe", 1, runA, "a#1", inside, 700n),
          claim("recurring", 7, runB, "b#1", inside, 500n),
          claim("retry", 1, assistant, "x#1", inside, 300n),
          claim("nooutcome", 8, runC, "c#1", before, 900n),
        ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(findings).where(eq(findings.workspaceId, scope.workspaceId));
      await tx.delete(totals).where(eq(totals.workspaceId, scope.workspaceId));
      await tx.delete(runs).where(inArray(runs.id, [assistantId]));
    });
    await closeDatabase();
  });

  it("reads the open and applied claims inside the window with each finding's kind and basis, and none of the assistant's", async () => {
    const read = await runInTenantScope(scope, () =>
      readCauseClaims(scope, window),
    );
    expect(
      read
        .map((c) => ({
          kind: c.kind,
          runId: c.runId,
          frameKey: c.frameKey,
          detector: c.detector,
          costMicros: c.costMicros,
          basis: c.basis,
        }))
        .sort((a, b) => (a.kind < b.kind ? -1 : 1)),
    ).toEqual([
      {
        kind: "duplicate_tool_calls",
        runId: runA,
        frameKey: "a#1",
        detector: 1,
        costMicros: 700n,
        basis: "gateway_observed",
      },
      {
        kind: "spin_loops",
        runId: runA,
        frameKey: "a#1",
        detector: 1,
        costMicros: 700n,
        basis: "client_attested",
      },
    ]);
  });

  it("counts the open findings whose calls all ran outside the window", async () => {
    // Spend with no outcome claims a call before the window only, and the
    // legacy duplicate tool calls finding claims none and covers days before
    // it. Context carry claims no call by kind, so it is not counted.
    expect(
      await runInTenantScope(scope, () => countFindingsOutside(scope, window)),
    ).toBe(2);
    // Over September only the retry loop's finding claims no call inside:
    // its one call ran on October 1. The legacy finding's window overlaps
    // September, so nothing says where its calls ran.
    expect(
      await runInTenantScope(scope, () =>
        countFindingsOutside(scope, {
          start: new Date("2026-09-01T00:00:00.000Z"),
          end: new Date("2026-10-01T00:00:00.000Z"),
        }),
      ),
    ).toBe(1);
  });
});
