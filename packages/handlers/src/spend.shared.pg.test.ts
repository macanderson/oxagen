// The spend run read against a real Postgres (ADR-235, 2026-10-02
// amendment). Every total counts the in-app assistant's runs, so the read
// keeps every row and marks each one whose run is on the `chat` or
// `api-chat` surface. A run on any other surface is not marked, and neither
// is a wrapped session's row, whose `tse_…` id never names an `agent_runs`
// row. `spend.shared.test.ts` pins the statement shape. This file proves the
// rows, with the citext cast in place. Runs wherever DATABASE_URL points at a
// migrated database (CI's `test` job). A local run without one is skipped.
// Every row it writes is removed in afterAll.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRunTotals, readUnmeteredRuns } from "./spend.shared";

const enabled = Boolean(process.env.DATABASE_URL);
// On CI a missing DATABASE_URL fails the file, so a green run means these
// cases ran instead of skipping.
if (process.env.CI && !enabled) throw new Error("The spend run read test needs DATABASE_URL on CI.");
const totals = schema.runTotals;
const runs = schema.agentRuns;

describe.skipIf(!enabled)("the spend run reads against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const runIds = {
    chat: crypto.randomUUID(),
    apiChat: crypto.randomUUID(),
    external: crypto.randomUUID(),
  };
  const publicIds: Record<keyof typeof runIds, string> = {
    chat: "",
    apiChat: "",
    external: "",
  };
  const session = `tse_spend_${tag}`;
  const startedAt = new Date("2026-09-10T12:00:00.000Z");
  const period = { from: "2026-09-10", to: "2026-09-10" };

  /** A sealed run row with one tool call and no model call. */
  const row = (runId: string, runSource: "ledger" | "tacho") => ({
    ...scope,
    runId,
    runSource,
    startedAt,
    sealedAt: new Date(startedAt.getTime() + 600_000),
    steps: 1,
    modelCalls: 0,
    toolCalls: 1,
    tokens: {},
    costMicros: null,
    costBasis: null,
    breakdown: { models: [], tools: [], steps: null },
    rolledUpAt: new Date("2026-09-15T00:00:00.000Z"),
  });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      const inserted = await tx
        .insert(runs)
        .values([
          { id: runIds.chat, ...scope, surface: "chat", spec: {} },
          { id: runIds.apiChat, ...scope, surface: "api-chat", spec: {} },
          { id: runIds.external, ...scope, surface: "external", spec: {} },
        ])
        .returning({ id: runs.id, publicId: runs.publicId });
      for (const run of inserted) {
        const key = (Object.keys(runIds) as Array<keyof typeof runIds>).find(
          (k) => runIds[k] === run.id,
        )!;
        publicIds[key] = run.publicId;
      }
      await tx
        .insert(totals)
        .values([
          row(publicIds.chat, "ledger"),
          row(publicIds.apiChat, "ledger"),
          row(publicIds.external, "ledger"),
          row(session, "tacho"),
        ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.delete(totals).where(eq(totals.workspaceId, scope.workspaceId));
      await tx.delete(runs).where(inArray(runs.id, Object.values(runIds)));
    });
    await closeDatabase();
  });

  it("keeps every run and marks the in-app assistant's", async () => {
    const rows = await runInTenantScope(scope, () =>
      readRunTotals(scope, { ...period, filter: { kind: "all" } }),
    );
    const inApp = new Map(rows.map((r) => [r.runId, r.inApp]));
    expect(inApp).toEqual(
      new Map([
        [publicIds.chat, true],
        [publicIds.apiChat, true],
        [publicIds.external, false],
        [session, false],
      ]),
    );
  });

  it("counts a wrapped session that reported no usage", async () => {
    const unmetered = await runInTenantScope(scope, () =>
      readUnmeteredRuns(scope, { ...period, filter: { kind: "all" } }),
    );
    expect(unmetered).toEqual({
      total: 1,
      byHarness: [{ harness: "unknown", runs: 1 }],
    });
  });
});
