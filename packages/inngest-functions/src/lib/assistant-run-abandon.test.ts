import { ENGINE_REVERSE_REQUEST_TIMEOUT_MS } from "@oxagen/agent/runtime/governed-turn";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  ledgerStore: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("./run-record", () => ({ ledgerStore: mocks.ledgerStore }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

const {
  ABANDON_SEALER_ID,
  ABANDONED_REASON_CODE,
  ASSISTANT_RUN_ABANDON_AFTER_MS,
  ASSISTANT_RUN_SURFACES,
  abandonCutoff,
  abandonedRunError,
  abandonSilentAssistantRuns,
  abandonSilentRun,
  listDedicatedPlaneScopes,
  listSilentAssistantRuns,
  silentAssistantRunsQuery,
} = await import("./assistant-run-abandon");

const NOW = new Date("2026-09-25T12:00:00.000Z");
const CUTOFF = new Date("2026-09-25T11:48:00.000Z");
const ORG = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const WS = "0192d4a8-7c1e-7a00-8000-0000000000a2";
const RUN = "0192d4a8-7c1e-7a00-8000-0000000000b1";
const ATTEMPT = "0192d4a8-7c1e-7a00-8000-0000000000c1";

/** A drizzle client that records each statement and answers queued rows. */
function proxyDb(answers: unknown[][][] = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (text, params) => {
    statements.push({ sql: text, params });
    return { rows: answers.shift() ?? [] };
  });
  return { db, statements };
}

function silent(over: Partial<{ attemptId: string | null }> = {}) {
  return {
    runId: RUN,
    publicId: "arun_0123456789abcdef012345",
    orgId: ORG,
    workspaceId: WS,
    attemptId: ATTEMPT,
    nextRunSeq: "7",
    lastEventAt: new Date("2026-09-25T11:30:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  mocks.withSystemDb.mockReset();
  mocks.withTenantDb.mockReset();
  mocks.runInTenantScope.mockReset();
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mocks.warn.mockReset();
});

describe("the abandon rule (#3988)", () => {
  it("waits twice the engine's deadline on one reverse request", () => {
    expect(ASSISTANT_RUN_ABANDON_AFTER_MS).toBe(
      2 * ENGINE_REVERSE_REQUEST_TIMEOUT_MS,
    );
    // Twelve minutes today. A change to the engine's deadline moves it.
    expect(ASSISTANT_RUN_ABANDON_AFTER_MS).toBe(12 * 60 * 1000);
    expect(abandonCutoff(NOW)).toEqual(CUTOFF);
  });

  it("covers every surface an assistant turn is admitted on", () => {
    expect(ASSISTANT_RUN_SURFACES).toEqual(["chat", "api-chat"]);
  });

  it("names the rule on the run it closed", () => {
    expect(abandonedRunError()).toBe(
      "No frame reached this run for 12 minutes, so the ledger sealed it abandoned.",
    );
  });
});

describe("silentAssistantRunsQuery", () => {
  it("reads open assistant runs by their last sign of life, oldest first", () => {
    const { db } = proxyDb();
    const query = silentAssistantRunsQuery(db as never, {
      cutoff: CUTOFF,
      limit: 200,
    }).toSQL();
    expect(query.sql).toContain('"agent_runs"."spec_version" = $');
    expect(query.sql).toContain('"agent_runs"."status" in ($');
    expect(query.sql).toContain('"agent_runs"."surface" in ($');
    expect(query.params).toEqual(
      expect.arrayContaining([
        2,
        "pending",
        "running",
        "chat",
        "api-chat",
        CUTOFF.toISOString(),
        200,
      ]),
    );
    // The last frame of the open attempt, by its own sequence, on the
    // server's clock. Else the attempt's start, else the run's admission.
    expect(query.sql).toMatch(
      /coalesce\(\s*\(SELECT e\.created_at FROM agent\.agent_run_events AS e\s+WHERE e\.attempt_id = agent_runs\.active_attempt_id\s+AND e\.event_record_version = 2\s+ORDER BY e\.attempt_seq DESC\s+LIMIT 1\),\s*\(SELECT a\.claimed_at FROM agent\.agent_run_attempts AS a\s+WHERE a\.id = agent_runs\.active_attempt_id\),\s*agent_runs\.created_at\s*\)/,
    );
    // Qualified in the select list too, where drizzle leaves its own
    // columns bare.
    expect(query.sql).not.toMatch(/= "active_attempt_id"/);
    expect(query.sql).toMatch(/order by coalesce\([\s\S]*\) asc limit \$\d+$/);
    // The compare-and-set token, as text so a bigint survives JSON.
    expect(query.sql).toContain('"next_run_seq"::text');
    // The shared scan names no workspace and leaves no organization out.
    expect(query.sql).not.toContain("not in");
  });

  it("reads one workspace in a scoped scan", () => {
    const { db } = proxyDb();
    const query = silentAssistantRunsQuery(db as never, {
      cutoff: CUTOFF,
      limit: 200,
      scope: { orgId: ORG, workspaceId: WS },
    }).toSQL();
    expect(query.sql).toContain('"agent_runs"."org_id" = $');
    expect(query.sql).toContain('"agent_runs"."workspace_id" = $');
    expect(query.params).toEqual(expect.arrayContaining([ORG, WS]));
  });

  it("leaves dedicated-plane organizations out of the shared scan", () => {
    const { db } = proxyDb();
    const other = "0192d4a8-7c1e-7a00-8000-0000000000d1";
    const query = silentAssistantRunsQuery(db as never, {
      cutoff: CUTOFF,
      limit: 200,
      excludeOrgIds: [other],
    }).toSQL();
    expect(query.sql).toContain('"agent_runs"."org_id" not in ($');
    expect(query.params).toContain(other);
  });
});

describe("listSilentAssistantRuns", () => {
  const row = [
    RUN,
    "arun_0123456789abcdef012345",
    ORG,
    WS,
    ATTEMPT,
    "7",
    "2026-09-25 11:30:00+00",
  ];

  it("scans the shared plane outside any tenant scope", async () => {
    const { db } = proxyDb([[row]]);
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(db),
    );
    const found = await listSilentAssistantRuns({
      cutoff: CUTOFF,
      limit: 200,
    });
    expect(found).toEqual([
      {
        runId: RUN,
        publicId: "arun_0123456789abcdef012345",
        orgId: ORG,
        workspaceId: WS,
        attemptId: ATTEMPT,
        nextRunSeq: "7",
        lastEventAt: new Date("2026-09-25T11:30:00.000Z"),
      },
    ]);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.runInTenantScope).not.toHaveBeenCalled();
  });

  it("scans a dedicated workspace in its own tenant scope", async () => {
    const { db, statements } = proxyDb([[]]);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(db),
    );
    const scope = { orgId: ORG, workspaceId: WS };
    expect(
      await listSilentAssistantRuns({ cutoff: CUTOFF, limit: 200, scope }),
    ).toEqual([]);
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      scope,
      expect.any(Function),
    );
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(statements[0]?.params).toEqual(expect.arrayContaining([ORG, WS]));
  });
});

describe("listDedicatedPlaneScopes", () => {
  it("lists the workspaces of every organization on a dedicated Postgres plane", async () => {
    const { db, statements } = proxyDb([[[ORG, WS]]]);
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(db),
    );
    expect(await listDedicatedPlaneScopes()).toEqual([
      { orgId: ORG, workspaceId: WS },
    ]);
    expect(statements[0]?.sql).toContain('"data_planes"."deleted_at" is null');
    expect(statements[0]?.params).toEqual(
      expect.arrayContaining(["postgres", "dedicated"]),
    );
  });
});

describe("abandonSilentRun", () => {
  it("closes the run in its tenant's scope under the read it was found by", async () => {
    const store = { abandonRun: vi.fn(async () => null) };
    await abandonSilentRun(silent(), store);
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      expect.any(Function),
    );
    expect(store.abandonRun).toHaveBeenCalledWith({
      runId: RUN,
      attemptId: ATTEMPT,
      expectedNextRunSeq: "7",
      reasonCode: ABANDONED_REASON_CODE,
      error: abandonedRunError(),
      sealerId: ABANDON_SEALER_ID,
    });
    expect(ABANDONED_REASON_CODE).toBe("producer_silent");
  });
});

describe("abandonSilentAssistantRuns", () => {
  function scanning(runs: ReturnType<typeof silent>[]) {
    const rows = runs.map((run) => [
      run.runId,
      run.publicId,
      run.orgId,
      run.workspaceId,
      run.attemptId,
      run.nextRunSeq,
      run.lastEventAt.toISOString(),
    ]);
    const { db } = proxyDb([rows]);
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(db),
    );
  }

  it("seals an open run past the limit and reports it for the rollup", async () => {
    scanning([silent()]);
    const store = {
      abandonRun: vi.fn(async () => ({ runId: RUN, seal: null })),
    };
    const pass = await abandonSilentAssistantRuns(
      { cutoff: CUTOFF, limit: 200 },
      store,
    );
    expect(pass).toEqual({
      found: 1,
      abandoned: [
        {
          publicId: "arun_0123456789abcdef012345",
          orgId: ORG,
          workspaceId: WS,
        },
      ],
    });
  });

  it("leaves a run that moved since the scan and reports nothing for it", async () => {
    scanning([silent()]);
    const store = { abandonRun: vi.fn(async () => null) };
    const pass = await abandonSilentAssistantRuns(
      { cutoff: CUTOFF, limit: 200 },
      store,
    );
    expect(pass).toEqual({ found: 1, abandoned: [] });
  });

  it("logs a run that fails to close and closes the rest", async () => {
    const other = { ...silent(), publicId: "arun_fedcba9876543210fedcba" };
    scanning([silent(), other]);
    const store = {
      abandonRun: vi
        .fn()
        .mockRejectedValueOnce(new Error("lock timeout"))
        .mockResolvedValueOnce({ runId: RUN, seal: null }),
    };
    const pass = await abandonSilentAssistantRuns(
      { cutoff: CUTOFF, limit: 200 },
      store,
    );
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(pass.abandoned.map((run) => run.publicId)).toEqual([
      "arun_fedcba9876543210fedcba",
    ]);
  });

  it("uses the ledger's own store when none is passed", async () => {
    scanning([]);
    const store = { abandonRun: vi.fn() };
    mocks.ledgerStore.mockReturnValue(store);
    const pass = await abandonSilentAssistantRuns({
      cutoff: CUTOFF,
      limit: 200,
    });
    expect(mocks.ledgerStore).toHaveBeenCalledTimes(1);
    expect(pass).toEqual({ found: 0, abandoned: [] });
  });
});
