import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Postgres mock ────────────────────────────────────────────────────────
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

// ── Neo4j mock — keep the real NodeLabels/EdgeTypes constants, replace only
// scopedSession so no real driver connection is ever attempted. ───────────
const mocks = vi.hoisted(() => ({
  sessionRun: vi.fn(
    async (_cypher: string, _params?: Record<string, unknown>) =>
      ({ records: [] }) as unknown,
  ),
  sessionClose: vi.fn(async () => undefined),
}));

vi.mock("@oxagen/ontology", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/ontology")>();
  return {
    ...real,
    scopedSession: vi.fn(() => ({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    })),
  };
});

import { withTenantDb } from "@oxagen/database";
import { scopedSession } from "@oxagen/ontology";
import {
  projectSubagentFanoutLineage,
  type ProjectSubagentFanoutLineageArgs,
} from "./lineage-projection";
import { CANCEL_ERROR_REASON } from "./lineage-outcome";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

const ROOT_FANOUT_ID = "33333333-3333-3333-3333-333333333333";
const NESTED_FANOUT_ID = "44444444-4444-4444-4444-444444444444";
const RUN_1_ID = "55555555-5555-5555-5555-555555555555";
const RUN_1_CHILD_MESSAGE_ID = "66666666-6666-6666-6666-666666666666";
const RUN_2_ID = "77777777-7777-7777-7777-777777777777";
const RUN_2_CHILD_MESSAGE_ID = "88888888-8888-8888-8888-888888888888";

interface FanoutTreeFixture {
  id: string;
  public_id: string;
  parent_message_id: string;
  status: string;
  total_children: number;
  completed_children: number;
  created_at: Date;
}

interface RunFixture {
  id: string;
  publicId: string;
  fanoutId: string;
  childMessageId: string;
  capabilityName: string;
  status: string;
  errorReason: string | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

const ROOT_FANOUT: FanoutTreeFixture = {
  id: ROOT_FANOUT_ID,
  public_id: "fan_root",
  parent_message_id: "00000000-0000-0000-0000-000000000000",
  status: "completed",
  total_children: 1,
  completed_children: 1,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
};

const NESTED_FANOUT: FanoutTreeFixture = {
  id: NESTED_FANOUT_ID,
  public_id: "fan_nested",
  // Recursion spine: nested fan-out's parent_message_id = the run that spawned it.
  parent_message_id: RUN_1_CHILD_MESSAGE_ID,
  status: "completed",
  total_children: 1,
  completed_children: 1,
  created_at: new Date("2026-01-01T00:01:00.000Z"),
};

const RUN_1: RunFixture = {
  id: RUN_1_ID,
  publicId: "sar_r1",
  fanoutId: ROOT_FANOUT_ID,
  childMessageId: RUN_1_CHILD_MESSAGE_ID,
  capabilityName: "dispatch_subagent",
  status: "completed",
  errorReason: null,
  attempts: 1,
  startedAt: new Date("2026-01-01T00:00:01.000Z"),
  completedAt: new Date("2026-01-01T00:02:00.000Z"),
};

const RUN_2: RunFixture = {
  id: RUN_2_ID,
  publicId: "sar_r2",
  fanoutId: NESTED_FANOUT_ID,
  childMessageId: RUN_2_CHILD_MESSAGE_ID,
  capabilityName: "research_web",
  status: "completed",
  errorReason: null,
  attempts: 1,
  startedAt: new Date("2026-01-01T00:01:01.000Z"),
  completedAt: new Date("2026-01-01T00:01:30.000Z"),
};

/** Wire withTenantDb so it satisfies BOTH call shapes the module issues:
 * `tx.execute(sql...)` (the recursive fan-out-tree walk) and
 * `tx.select({...}).from(...).where(...)` (the runs-for-fanouts lookup). */
function mockPostgres(fanouts: FanoutTreeFixture[], runs: RunFixture[]) {
  const tx = {
    execute: vi.fn(async () => fanouts),
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(runs),
      }),
    })),
  };
  vi.mocked(withTenantDb).mockImplementation(
    (fn) => (fn as (tx: unknown) => Promise<unknown>)(tx) as never,
  );
  return tx;
}

function baseArgs(
  overrides: Partial<ProjectSubagentFanoutLineageArgs> = {},
): ProjectSubagentFanoutLineageArgs {
  return {
    fanoutId: ROOT_FANOUT_ID,
    orgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

/** Every (cypher, params) pair captured by the mocked scopedSession().run(). */
function capturedRunCalls(): Array<[string, Record<string, unknown>]> {
  return mocks.sessionRun.mock.calls as Array<
    [string, Record<string, unknown>]
  >;
}

beforeEach(() => {
  vi.mocked(withTenantDb).mockReset();
  vi.mocked(scopedSession).mockClear();
  mocks.sessionRun.mockClear();
  mocks.sessionRun.mockImplementation(async () => ({ records: [] }) as unknown);
  mocks.sessionClose.mockClear();
  mocks.sessionClose.mockResolvedValue(undefined);
});

describe("projectSubagentFanoutLineage — multi-level tree", () => {
  it("projects fan-out nodes, run nodes, DISPATCHED edges, and SPAWNED_FANOUT edges for a nested dispatch", async () => {
    mockPostgres([ROOT_FANOUT, NESTED_FANOUT], [RUN_1, RUN_2]);

    await projectSubagentFanoutLineage(baseArgs());

    const calls = capturedRunCalls();
    // fanouts, runs, DISPATCHED edges, SPAWNED_FANOUT edges — in that order.
    expect(calls).toHaveLength(4);

    const [fanoutCall, runCall, dispatchedCall, spawnedCall] = calls;

    expect(fanoutCall![0]).toMatch(/MERGE \(f:SubagentFanout/);
    const fanoutParams = fanoutCall![1]!.fanouts as Array<
      Record<string, unknown>
    >;
    expect(fanoutParams.map((f) => f.id)).toEqual([
      ROOT_FANOUT_ID,
      NESTED_FANOUT_ID,
    ]);

    expect(runCall![0]).toMatch(/MERGE \(r:SubagentRun/);
    const runParams = runCall![1]!.runs as Array<Record<string, unknown>>;
    expect(runParams.map((r) => r.id)).toEqual([RUN_1_ID, RUN_2_ID]);

    expect(dispatchedCall![0]).toMatch(/MERGE \(f\)-\[:DISPATCHED\]->\(r\)/);

    expect(spawnedCall![0]).toMatch(/MERGE \(r\)-\[:SPAWNED_FANOUT\]->\(f\)/);
    const links = spawnedCall![1]!.links as Array<Record<string, unknown>>;
    // RUN_1's childMessageId matches NESTED_FANOUT's parentMessageId — the
    // recursion spine — so RUN_1 is recorded as having spawned NESTED_FANOUT.
    expect(links).toEqual([
      { runId: RUN_1_ID, childFanoutId: NESTED_FANOUT_ID },
    ]);

    expect(mocks.sessionClose).toHaveBeenCalledTimes(1);
  });
});

describe("projectSubagentFanoutLineage — idempotency", () => {
  it("issues the identical statements on a second run (safe to run repeatedly)", async () => {
    mockPostgres([ROOT_FANOUT, NESTED_FANOUT], [RUN_1, RUN_2]);
    await projectSubagentFanoutLineage(baseArgs());
    const firstCalls = capturedRunCalls().map(([cypher, params]) => [
      cypher,
      JSON.parse(JSON.stringify(params)),
    ]);

    mocks.sessionRun.mockClear();
    mockPostgres([ROOT_FANOUT, NESTED_FANOUT], [RUN_1, RUN_2]);
    await projectSubagentFanoutLineage(baseArgs());
    const secondCalls = capturedRunCalls().map(([cypher, params]) => [
      cypher,
      JSON.parse(JSON.stringify(params)),
    ]);

    expect(secondCalls).toEqual(firstCalls);
  });

  it("every write uses MERGE on a stable {id, orgId, workspaceId} key, never CREATE for the node itself", async () => {
    mockPostgres([ROOT_FANOUT], [RUN_1]);
    await projectSubagentFanoutLineage(baseArgs());
    const calls = capturedRunCalls();
    for (const [cypher] of calls) {
      expect(cypher).toContain("MERGE");
      // "ON CREATE SET" is MERGE's conditional branch, not a standalone
      // unconditional node/relationship creation clause — only ban the latter.
      expect(cypher).not.toMatch(/(?<!ON )CREATE \(/);
    }
    // The two node-upsert statements specifically MERGE on the dual
    // {id, orgId, workspaceId} key — the stable idempotency key.
    const [fanoutCall, runCall] = calls;
    expect(fanoutCall![0]).toMatch(
      /MERGE \(f:SubagentFanout \{id: fo\.id, orgId: \$orgId, workspaceId: \$workspaceId\}\)/,
    );
    expect(runCall![0]).toMatch(
      /MERGE \(r:SubagentRun \{id: ru\.id, orgId: \$orgId, workspaceId: \$workspaceId\}\)/,
    );
  });
});

describe("projectSubagentFanoutLineage — outcome distinction", () => {
  it("projects a genuinely failed run and a cancelled run with distinct outcomes", async () => {
    const failedRun: RunFixture = {
      ...RUN_1,
      status: "failed",
      errorReason: "dispatch emit failed: boom",
    };
    const cancelledRun: RunFixture = {
      ...RUN_2,
      fanoutId: ROOT_FANOUT_ID,
      status: "failed",
      errorReason: CANCEL_ERROR_REASON,
    };
    mockPostgres([ROOT_FANOUT], [failedRun, cancelledRun]);

    await projectSubagentFanoutLineage(baseArgs());

    const runCall = capturedRunCalls().find(([cypher]) =>
      cypher.includes(":SubagentRun {"),
    );
    const runParams = runCall![1]!.runs as Array<Record<string, unknown>>;
    const outcomeById = new Map(runParams.map((r) => [r.id, r.outcome]));
    expect(outcomeById.get(RUN_1_ID)).toBe("failed");
    expect(outcomeById.get(RUN_2_ID)).toBe("cancelled");
    expect(outcomeById.get(RUN_1_ID)).not.toBe(outcomeById.get(RUN_2_ID));
  });
});

describe("projectSubagentFanoutLineage — never-finalized fanout", () => {
  it("still projects a fanout stuck in 'pending' with only 'pending'/'running' child rows", async () => {
    const pendingFanout: FanoutTreeFixture = {
      ...ROOT_FANOUT,
      status: "pending",
      completed_children: 0,
    };
    const pendingRun: RunFixture = {
      ...RUN_1,
      status: "pending",
      startedAt: null,
      completedAt: null,
    };
    mockPostgres([pendingFanout], [pendingRun]);

    await projectSubagentFanoutLineage(baseArgs());

    const calls = capturedRunCalls();
    // fanout + run + DISPATCHED edge — no SPAWNED_FANOUT link exists.
    expect(calls).toHaveLength(3);
    const fanoutParams = calls[0]![1]!.fanouts as Array<
      Record<string, unknown>
    >;
    expect(fanoutParams[0]!.status).toBe("pending");
    const runParams = calls[1]![1]!.runs as Array<Record<string, unknown>>;
    expect(runParams[0]!.outcome).toBe("pending");
  });

  it("no-ops (never opens a graph session) when the fanout id resolves to no rows", async () => {
    mockPostgres([], []);
    await projectSubagentFanoutLineage(baseArgs());
    expect(scopedSession).not.toHaveBeenCalled();
  });

  it("skips run/edge writes but still writes the fanout node when a fanout has zero runs", async () => {
    mockPostgres([ROOT_FANOUT], []);
    await projectSubagentFanoutLineage(baseArgs());
    const calls = capturedRunCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatch(/SubagentFanout/);
  });
});

describe("projectSubagentFanoutLineage — SCOPE_GUARD (orgId token)", () => {
  it("every Cypher statement literally contains the `orgId` token", async () => {
    mockPostgres([ROOT_FANOUT, NESTED_FANOUT], [RUN_1, RUN_2]);
    await projectSubagentFanoutLineage(baseArgs());
    const calls = capturedRunCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const [cypher] of calls) {
      expect(cypher).toMatch(/\borgId\b/);
    }
  });
});

describe("projectSubagentFanoutLineage — four-store boundary", () => {
  it("never writes a spend/token/cost property to Neo4j", async () => {
    mockPostgres([ROOT_FANOUT, NESTED_FANOUT], [RUN_1, RUN_2]);
    await projectSubagentFanoutLineage(baseArgs());

    const forbidden = /cost|spend|token|usd|micros|price/i;
    for (const [cypher, params] of capturedRunCalls()) {
      expect(cypher).not.toMatch(forbidden);
      expect(JSON.stringify(params)).not.toMatch(forbidden);
    }
  });
});

describe("projectSubagentFanoutLineage — failure propagation", () => {
  it("propagates a Postgres read failure rather than swallowing it", async () => {
    vi.mocked(withTenantDb).mockRejectedValue(
      new Error("postgres unavailable"),
    );
    await expect(projectSubagentFanoutLineage(baseArgs())).rejects.toThrow(
      "postgres unavailable",
    );
  });

  it("propagates a scopedSession/Neo4j failure rather than swallowing it — callers are responsible for catching (see agent.subagent.cancel.ts / agent.execute-subagent.ts)", async () => {
    mockPostgres([ROOT_FANOUT], [RUN_1]);
    mocks.sessionRun.mockRejectedValueOnce(new Error("neo4j unavailable"));
    await expect(projectSubagentFanoutLineage(baseArgs())).rejects.toThrow(
      "neo4j unavailable",
    );
    // The session is still closed even on failure.
    expect(mocks.sessionClose).toHaveBeenCalledTimes(1);
  });
});
