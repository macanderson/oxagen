import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  dbInsertValues: vi.fn(),
  dbInsertOnConflict: vi.fn(),
  dbInsert: vi.fn(),
  sumTokenUsage: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
}));

// Drizzle db mock: db().query.subscriptions.findMany / db().insert().values().onConflictDoUpdate()
mocks.dbInsertOnConflict.mockResolvedValue(undefined);
mocks.dbInsertValues.mockReturnValue({ onConflictDoUpdate: mocks.dbInsertOnConflict });
mocks.dbInsert.mockReturnValue({ values: mocks.dbInsertValues });

const fakeDb = {
  query: { subscriptions: { findMany: mocks.findMany } },
  insert: mocks.dbInsert,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  db: () => fakeDb,
  withSystemDb: async (fn: (tx: typeof fakeDb) => unknown) => fn(fakeDb),

  };
});

vi.mock("@oxagen/telemetry", () => ({
  sumTokenUsage: mocks.sumTokenUsage,
}));

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, error: vi.fn() },
}));

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ INNGEST_EVENT_KEY: "evt-test", INNGEST_SIGNING_KEY: "sign-test", NODE_ENV: "test" }),
  normalizeEnv: (e: unknown) => e,
}));

// Capture the handler
let capturedHandler: ((ctx: { step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> } }) => Promise<unknown>) | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
  },
);

await import("./billing.rollup-usage");

// step.run that executes fn immediately
function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("billingRollupUsage Inngest handler", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.dbInsert.mockClear();
    mocks.dbInsertValues.mockClear();
    mocks.dbInsertOnConflict.mockReset();
    mocks.sumTokenUsage.mockReset();
    mocks.loggerInfo.mockClear();
    // Restore insert chain defaults
    mocks.dbInsertOnConflict.mockResolvedValue(undefined);
    mocks.dbInsertValues.mockReturnValue({ onConflictDoUpdate: mocks.dbInsertOnConflict });
    mocks.dbInsert.mockReturnValue({ values: mocks.dbInsertValues });
  });

  it("exits cleanly and logs 0 processed when no active subscriptions exist", async () => {
    // Empty batch on the first call → loop exits immediately
    mocks.findMany.mockResolvedValueOnce([]);

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ totalProcessed: 0 });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { totalProcessed: 0 },
      "rollup-usage complete",
    );
    // No upsert should have been issued
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("advances cursor and processes a single page of subscriptions", async () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const later = new Date("2025-02-01T00:00:00Z");
    const sub = {
      id: "sub_aaa",
      orgId: "org_1",
      currentPeriodStart: now,
      currentPeriodEnd: later,
    };
    // Page 1 returns one row; page 2 returns empty (stops the loop)
    mocks.findMany
      .mockResolvedValueOnce([sub])
      .mockResolvedValueOnce([]);

    mocks.sumTokenUsage.mockResolvedValue([
      { metric: "tokens_input", quantity: 100, costMicros: 0n },
    ]);

    const result = await capturedHandler!({ step: makeStep() });

    // One subscription processed
    expect(result).toEqual({ totalProcessed: 1 });
    // sumTokenUsage called with correct period
    expect(mocks.sumTokenUsage).toHaveBeenCalledWith({
      orgId: "org_1",
      periodStart: expect.any(Date) as unknown,
      periodEnd: expect.any(Date) as unknown,
    });
    // Upsert issued once
    expect(mocks.dbInsertValues).toHaveBeenCalledTimes(1);
  });

  it("calls idempotent upsert (onConflictDoUpdate) for each usage row", async () => {
    const sub = {
      id: "sub_bbb",
      orgId: "org_2",
      currentPeriodStart: new Date("2025-01-01T00:00:00Z"),
      currentPeriodEnd: new Date("2025-02-01T00:00:00Z"),
    };
    mocks.findMany.mockResolvedValueOnce([sub]).mockResolvedValueOnce([]);
    mocks.sumTokenUsage.mockResolvedValue([
      { metric: "executions", quantity: 5, costMicros: 500n },
    ]);

    await capturedHandler!({ step: makeStep() });

    // onConflictDoUpdate must be called (idempotence contract)
    expect(mocks.dbInsertOnConflict).toHaveBeenCalledTimes(1);
  });

  it("skips the upsert when sumTokenUsage returns an empty array", async () => {
    const sub = {
      id: "sub_ccc",
      orgId: "org_3",
      currentPeriodStart: new Date("2025-01-01T00:00:00Z"),
      currentPeriodEnd: new Date("2025-02-01T00:00:00Z"),
    };
    mocks.findMany.mockResolvedValueOnce([sub]).mockResolvedValueOnce([]);
    mocks.sumTokenUsage.mockResolvedValue([]);

    await capturedHandler!({ step: makeStep() });

    // No upsert issued for an org with zero usage
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });
});
