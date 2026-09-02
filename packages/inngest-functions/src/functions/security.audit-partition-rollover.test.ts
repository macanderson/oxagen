// Unit tests for security.audit-partition-rollover.
//
// The Inngest function manages monthly Postgres partitions for
// security.security_events. We capture the handler via a mocked `inngest`,
// drive its two `step.run` blocks, and assert the create/skip/drop behaviour
// by controlling what the (mocked) withSystemDb transaction's `execute`
// returns for each query.
//
// System time is pinned (vi.setSystemTime) so the computed partition names and
// the 7-year retention cutoff are deterministic regardless of when CI runs —
// October is chosen so the 2-month look-ahead crosses into December, exercising
// partitionSpec's year-rollover branch.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

// One fake tenant-system transaction whose `execute` we script per call.
const fakeTx = { execute: mocks.execute };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    // The rollover runs all DDL through withSystemDb (system/cron RLS bypass).
    withSystemDb: async (fn: (tx: typeof fakeTx) => Promise<unknown>) =>
      fn(fakeTx),
  };
});

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, error: mocks.loggerError },
}));

// Capture the registration args the module passes at import time. These are
// module-level (not vi.fn state) so they survive vi.clearAllMocks() in
// beforeEach — createFunction only runs once, when the module is imported.
type StepCtx = {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
};
let capturedHandler: ((ctx: StepCtx) => Promise<unknown>) | null = null;
let capturedOpts: {
  id: string;
  retries: number;
  concurrency: { limit: number };
} | null = null;
let capturedTrigger: { cron: string } | null = null;

vi.mock("../create-function", () => ({
  createFunction: (
    opts: { id: string; retries: number; concurrency: { limit: number } },
    trigger: { cron: string },
    handler: (ctx: StepCtx) => Promise<unknown>,
  ) => {
    capturedOpts = opts;
    capturedTrigger = trigger;
    capturedHandler = handler;
    return [{ id: "security.audit-partition-rollover" }];
  },
}));

// Import AFTER the mocks so createFunction captures the handler.
await import("./security.audit-partition-rollover");

// step.run that simply invokes the callback (no Inngest durability in unit tests).
const step = {
  run: async (_name: string, fn: () => Promise<unknown>) => fn(),
};

describe("securityAuditPartitionRollover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // October → the 2-month look-ahead reaches December (partitionSpec rollover).
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers as a concurrency-1, retrying cron function", () => {
    expect(capturedHandler).toBeTypeOf("function");
    expect(capturedOpts?.id).toBe("security.audit-partition-rollover");
    expect(capturedOpts?.concurrency.limit).toBe(1);
    expect(capturedOpts?.retries).toBeGreaterThan(0);
    expect(capturedTrigger?.cron).toBe("0 3 1 * *");
  });

  it("creates missing upcoming partitions, skips existing, and drops expired ones", async () => {
    // execute() call sequence across both steps:
    //   1. exists-check, offset +1 (Nov 2026) → not present → triggers CREATE
    //   2. CREATE TABLE for Nov 2026
    //   3. exists-check, offset +2 (Dec 2026) → already present → skipped
    //   4. list child partitions
    //   5. DROP for the single expired partition (2000_01)
    mocks.execute
      .mockResolvedValueOnce([{ exists: false }]) // 1
      .mockResolvedValueOnce([]) // 2
      .mockResolvedValueOnce([{ exists: true }]) // 3
      .mockResolvedValueOnce([
        { relname: "security_events_2000_01" }, // > 7y old → drop
        { relname: "security_events_2099_01" }, // future → keep
        { relname: "not_a_partition_name" }, // unparseable → skipped safely
      ]) // 4
      .mockResolvedValueOnce([]); // 5

    const result = (await capturedHandler!({ step })) as {
      created: string[];
      skipped: string[];
      dropped: string[];
    };

    expect(result.created).toEqual(["security_events_2026_11"]);
    expect(result.skipped).toEqual(["security_events_2026_12"]);
    expect(result.dropped).toEqual(["security_events_2000_01"]);

    // Exactly 5 statements: 2 exists-checks + 1 create + 1 list + 1 drop.
    expect(mocks.execute).toHaveBeenCalledTimes(5);
    // Both steps logged their summary, plus the final completion log.
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(3);
  });

  it("creates both look-ahead partitions when neither exists yet", async () => {
    mocks.execute
      .mockResolvedValueOnce([{ exists: false }]) // offset +1 absent
      .mockResolvedValueOnce([]) // create +1
      .mockResolvedValueOnce([{ exists: false }]) // offset +2 absent
      .mockResolvedValueOnce([]) // create +2
      .mockResolvedValueOnce([]); // drop step: no partitions

    const result = (await capturedHandler!({ step })) as {
      created: string[];
      skipped: string[];
      dropped: string[];
    };

    expect(result.created).toEqual([
      "security_events_2026_11",
      "security_events_2026_12",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("skips both partitions and drops nothing when everything is current", async () => {
    mocks.execute
      .mockResolvedValueOnce([{ exists: true }]) // offset +1 present
      .mockResolvedValueOnce([{ exists: true }]) // offset +2 present
      .mockResolvedValueOnce([{ relname: "security_events_2099_01" }]); // only future partition

    const result = (await capturedHandler!({ step })) as {
      created: string[];
      skipped: string[];
      dropped: string[];
    };

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([
      "security_events_2026_11",
      "security_events_2026_12",
    ]);
    expect(result.dropped).toEqual([]);
    // 2 exists-checks + 1 list, no CREATE/DROP statements.
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });
});
