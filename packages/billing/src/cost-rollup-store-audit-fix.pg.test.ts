// listRunsAwaitingRollup against a real Postgres: a sealed tacho run whose
// tree took a batch after its row was written is rolled up again, so a
// subagent's frames that arrive after the root seals reach
// `cost.run_totals`. A session in another workspace that names the root does
// not count. Runs wherever DATABASE_URL points at a migrated database (CI's
// `test` job); a local run without one is skipped, not red. Every row it
// writes is removed in afterAll.
//
// The seals are in 1999 so these runs sort ahead of whatever else the
// database holds: the lister reads every organization, oldest seal first.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRunsAwaitingRollup } from "./cost-rollup-store";

const enabled = Boolean(process.env.DATABASE_URL);
const sessions = schema.tachoSessions;
const totals = schema.runTotals;

describe.skipIf(!enabled)("listRunsAwaitingRollup against Postgres", () => {
  const orgId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const tag = crypto.randomUUID().slice(0, 8);
  const at = (hhmm: string) => new Date(`1999-01-01T${hhmm}:00.000Z`);
  const publicId = (name: string) => `tse_audit_${tag}_${name}`;
  const uuids = new Map<string, string>();
  const uuidOf = (name: string) => {
    const known = uuids.get(name);
    if (known) return known;
    const fresh = crypto.randomUUID();
    uuids.set(name, fresh);
    return fresh;
  };

  const session = (
    name: string,
    over: {
      root: string;
      lastEventAt: string;
      sealedAt?: string;
      workspaceId?: string;
    },
  ) => ({
    publicId: publicId(name),
    orgId,
    workspaceId: over.workspaceId ?? workspaceId,
    sessionUuid: uuidOf(name),
    harnessSessionId: `sess-${name}-${tag}`,
    agentKey: `audit.core.bot-${tag}`,
    rootSessionUuid: uuidOf(over.root),
    parentSessionUuid: over.root === name ? null : uuidOf(over.root),
    runtime: "claude-code",
    harness: "claude-code",
    outcome: over.sealedAt ? "completed" : "running",
    enforcementTier: "observe",
    startedAt: at("00:00"),
    lastEventAt: at(over.lastEventAt),
    sealedAt: over.sealedAt ? at(over.sealedAt) : null,
  });
  const rolledUp = (name: string, hhmm: string) => ({
    orgId,
    workspaceId,
    runId: publicId(name),
    runSource: "tacho",
    startedAt: at("00:00"),
    steps: 1,
    modelCalls: 1,
    toolCalls: 0,
    tokens: {},
    costMicros: null,
    costBasis: null,
    breakdown: { models: [], tools: [] },
    rolledUpAt: at(hhmm),
  });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(sessions).values([
        // Rolled up at 00:20, after its seal; a subagent's batch landed at
        // 00:30.
        session("late", {
          root: "late",
          lastEventAt: "00:10",
          sealedAt: "00:10",
        }),
        session("late-child", { root: "late", lastEventAt: "00:30" }),
        // Every batch of its tree landed before the rollup.
        session("settled", {
          root: "settled",
          lastEventAt: "00:10",
          sealedAt: "00:10",
        }),
        session("settled-child", { root: "settled", lastEventAt: "00:15" }),
        // A session in another workspace names this root after its rollup.
        session("fenced", {
          root: "fenced",
          lastEventAt: "00:10",
          sealedAt: "00:10",
        }),
        session("fenced-stranger", {
          root: "fenced",
          lastEventAt: "00:30",
          workspaceId: otherWorkspaceId,
        }),
        // Never rolled up at all.
        session("unrolled", {
          root: "unrolled",
          lastEventAt: "00:10",
          sealedAt: "00:10",
        }),
      ]);
      await tx
        .insert(totals)
        .values([
          rolledUp("late", "00:20"),
          rolledUp("settled", "00:20"),
          rolledUp("fenced", "00:20"),
        ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(totals).where(eq(totals.orgId, orgId));
      await tx.delete(sessions).where(eq(sessions.orgId, orgId));
    });
    await closeDatabase();
  });

  it("lists a run whose tree took a batch after its row was written, and no settled one", async () => {
    const listed = new Set(await listRunsAwaitingRollup({ limit: 500 }));
    expect(listed.has(publicId("late"))).toBe(true);
    expect(listed.has(publicId("unrolled"))).toBe(true);
    expect(listed.has(publicId("settled"))).toBe(false);
    expect(listed.has(publicId("fenced"))).toBe(false);
    // Only roots are runs.
    expect(listed.has(publicId("late-child"))).toBe(false);
  });
});
