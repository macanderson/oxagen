// The frame-time spend reads against a real Postgres (#4574). The unit test
// drives the arithmetic through fakes. This runs the SQL: the contained sum,
// the crossing list with its last-frame bound, and both run-ref lookups, in a
// tenant scope that holds no row. Postgres parses and plans each statement, so
// a bad cast or a bound the planner refuses fails here rather than on a page
// view, and each read answers nothing.
//
// Runs wherever DATABASE_URL points at a migrated database (CI's `test` job);
// a local run without one is skipped, not red. The first block writes no
// rows. The second writes a few runs and sessions and removes them.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frameTimeSpendDeps } from "./frame-time-spend";

const enabled = Boolean(process.env.DATABASE_URL);

// One pool serves both blocks, so it closes once, after the last of them.
afterAll(async () => {
  if (enabled) await closeDatabase();
});

describe.skipIf(!enabled)("frame-time spend against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const window = {
    start: new Date("2026-09-01T00:00:00.000Z"),
    end: new Date("2026-10-01T00:00:00.000Z"),
  };

  it.each([
    ["every run", null],
    ["named operators", ["prn_0000000000000000000ana"]],
  ] as const)(
    "lists no run for %s in an empty workspace",
    async (_label, keys) => {
      expect(
        await runInTenantScope(scope, () =>
          frameTimeSpendDeps.readRuns(scope, window, keys),
        ),
      ).toEqual({ contained: [], crossing: [] });
    },
  );

  it.each(["arun_0000000000000000000000", "tse_0000000000000000000000"])(
    "prices nothing for a run %s the workspace does not hold",
    async (runId) => {
      expect(
        await runInTenantScope(scope, () =>
          frameTimeSpendDeps.priceRunFrames(scope, runId, window),
        ),
      ).toBeNull();
    },
  );
});

// #5294: an unsealed run is bounded by the last batch its session tree sent,
// not only by its last rollup. A reprice that rolls up a run that went quiet
// before the window no longer makes it a crossing run, and an open run that
// started and went quiet inside the window counts whole. Every row it writes
// is removed in afterAll.
describe.skipIf(!enabled)("the frame-time bound against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };
  const window = {
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-10-02T00:00:00.000Z"),
  };
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const at = (iso: string) => new Date(iso);
  /** A reprice inside the window, and one after it. */
  const repricedIn = at("2026-10-01T02:00:00.000Z");
  const repricedAfter = at("2026-10-02T02:00:00.000Z");
  const uuids = {
    quiet: crypto.randomUUID(),
    busy: crypto.randomUUID(),
    busyChild: crypto.randomUUID(),
    inside: crypto.randomUUID(),
  };
  const publicId = (name: keyof typeof uuids) =>
    `tse_${tag}${name.toLowerCase().padEnd(14, "0").slice(0, 14)}`;
  const ledger = `arun_${tag}ledger00000000`;

  const session = (
    name: keyof typeof uuids,
    over: { root?: keyof typeof uuids; startedAt: Date; lastEventAt: Date },
  ) => ({
    publicId: publicId(name),
    ...scope,
    sessionUuid: uuids[name],
    harnessSessionId: `sess-${name}-${tag}`,
    agentKey: `spend.core.bot-${tag}`,
    rootSessionUuid: uuids[over.root ?? name],
    parentSessionUuid: over.root ? uuids[over.root] : null,
    runtime: "claude-code",
    harness: "claude-code",
    startedAt: over.startedAt,
    lastEventAt: over.lastEventAt,
    sealedAt: null,
    seqCount: 7,
    lastHash: `sha256:${"a".repeat(64)}`,
    numToolCalls: 1,
    toolBodyFrames: 1,
    contentFrames: 2,
    bodyFrames: 2,
  });

  /** An unsealed, priced run row. */
  const row = (
    runId: string,
    runSource: "ledger" | "tacho",
    startedAt: Date,
    rolledUpAt: Date,
  ) => ({
    ...scope,
    runId,
    runSource,
    startedAt,
    sealedAt: null,
    steps: 1,
    modelCalls: 1,
    toolCalls: 0,
    tokens: {},
    costMicros: 1_000n,
    costBasis: "client_attested",
    breakdown: { models: [], tools: [], steps: null },
    rolledUpAt,
  });

  beforeAll(async () => {
    await withSystemDb(async (tx) => {
      await tx.insert(schema.tachoSessions).values([
        // Went quiet on September 20.
        session("quiet", {
          startedAt: at("2026-09-20T10:00:00.000Z"),
          lastEventAt: at("2026-09-20T11:00:00.000Z"),
        }),
        // Its root went quiet before the window and its subagent sent a
        // batch inside it.
        session("busy", {
          startedAt: at("2026-09-30T22:00:00.000Z"),
          lastEventAt: at("2026-09-30T22:30:00.000Z"),
        }),
        session("busyChild", {
          root: "busy",
          startedAt: at("2026-09-30T22:10:00.000Z"),
          lastEventAt: at("2026-10-01T00:30:00.000Z"),
        }),
        // Started and went quiet inside the window.
        session("inside", {
          startedAt: at("2026-10-01T03:00:00.000Z"),
          lastEventAt: at("2026-10-01T04:00:00.000Z"),
        }),
      ]);
      await tx
        .insert(schema.runTotals)
        .values([
          row(publicId("quiet"), "tacho", at("2026-09-20T10:00:00.000Z"), repricedIn),
          row(publicId("busy"), "tacho", at("2026-09-30T22:00:00.000Z"), repricedIn),
          row(publicId("inside"), "tacho", at("2026-10-01T03:00:00.000Z"), repricedAfter),
          // A ledger run has no session tree: its last rollup still bounds it.
          row(ledger, "ledger", at("2026-09-25T10:00:00.000Z"), repricedIn),
        ]);
    });
  });

  afterAll(async () => {
    await withSystemDb(async (tx) => {
      await tx
        .delete(schema.runTotals)
        .where(eq(schema.runTotals.workspaceId, scope.workspaceId));
      await tx
        .delete(schema.tachoSessions)
        .where(inArray(schema.tachoSessions.sessionUuid, Object.values(uuids)));
    });
  });

  it("leaves out a run that went quiet before the window, counts one that went quiet inside it whole, and prices the rest by their frames", async () => {
    const { contained, crossing } = await runInTenantScope(scope, () =>
      frameTimeSpendDeps.readRuns(scope, window, null),
    );
    expect(contained).toEqual([
      { operatorKey: null, currency: "USD", micros: 1_000n },
    ]);
    expect(crossing.map((run) => run.runId).sort()).toEqual(
      [publicId("busy"), ledger].sort(),
    );
  });
});
