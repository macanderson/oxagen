import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  sweepDunning: vi.fn(),
  isLowBalance: vi.fn(),
  notifyLowBalance: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  sweepDunning: mocks.sweepDunning,
  isLowBalance: mocks.isLowBalance,
  notifyLowBalance: mocks.notifyLowBalance,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {
    orgBillingSettings: { dunningState: "dunning_state", orgId: "org_id" },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((...args: unknown[]) => args),
    and: vi.fn((...args: unknown[]) => args),
    gt: vi.fn((...args: unknown[]) => args),
    asc: vi.fn((...args: unknown[]) => args),
  };
});

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.inngestCreateFunction,
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    INNGEST_EVENT_KEY: "evt-test",
    INNGEST_SIGNING_KEY: "sign-test",
    NODE_ENV: "test",
  }),
  normalizeEnv: (e: unknown) => e,
}));

// Capture the handler at module-load time (same pattern as sibling tests).
let capturedHandler:
  | ((ctx: {
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./billing.dunning-sweep");

// step.run helper: executes the callback immediately (no Inngest infra needed).
function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("billingDunningSweep Inngest handler", () => {
  beforeEach(() => {
    mocks.sweepDunning.mockReset();
    mocks.isLowBalance.mockReset();
    mocks.notifyLowBalance.mockReset();
    mocks.withSystemDb.mockReset();
    mocks.loggerInfo.mockClear();
    mocks.loggerWarn.mockClear();
    // Default: no active orgs to check for low balance.
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const fakeTx = {
          query: {
            orgBillingSettings: {
              findMany: vi.fn().mockResolvedValue([]),
            },
          },
        };
        return fn(fakeTx);
      },
    );
  });

  it("calls sweepDunning once per invocation", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 0 });

    await capturedHandler!({ step: makeStep() });

    expect(mocks.sweepDunning).toHaveBeenCalledTimes(1);
  });

  it("returns the result produced by sweepDunning plus lowBalanceNotified count", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 3 });

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ suspended: 3, lowBalanceNotified: 0 });
  });

  it("logs completion with the suspended count and lowBalanceNotified", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 7 });

    await capturedHandler!({ step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { suspended: 7, lowBalanceNotified: 0 },
      "billing.dunning-sweep complete",
    );
  });

  it("logs zero when no orgs are suspended", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 0 });

    await capturedHandler!({ step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { suspended: 0, lowBalanceNotified: 0 },
      "billing.dunning-sweep complete",
    );
  });

  it("propagates errors thrown by sweepDunning", async () => {
    mocks.sweepDunning.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(capturedHandler!({ step: makeStep() })).rejects.toThrow(
      "DB connection lost",
    );
  });

  it("checks active orgs for low balance and notifies when low", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 0 });
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const fakeTx = {
          query: {
            orgBillingSettings: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ orgId: "org-1" }, { orgId: "org-2" }]),
            },
          },
        };
        return fn(fakeTx);
      },
    );
    mocks.isLowBalance
      .mockResolvedValueOnce({
        low: true,
        balanceCents: 100,
        thresholdCents: 500,
      })
      .mockResolvedValueOnce({
        low: false,
        balanceCents: 1000,
        thresholdCents: 500,
      });
    mocks.notifyLowBalance.mockResolvedValue(undefined);

    const result = await capturedHandler!({ step: makeStep() });

    expect(mocks.isLowBalance).toHaveBeenCalledTimes(2);
    expect(mocks.notifyLowBalance).toHaveBeenCalledTimes(1);
    expect(mocks.notifyLowBalance).toHaveBeenCalledWith("org-1", {
      low: true,
      balanceCents: 100,
      thresholdCents: 500,
    });
    expect(result).toEqual({ suspended: 0, lowBalanceNotified: 1 });
  });

  it("handles low-balance check failures gracefully without crashing", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 0 });
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const fakeTx = {
          query: {
            orgBillingSettings: {
              findMany: vi.fn().mockResolvedValue([{ orgId: "org-err" }]),
            },
          },
        };
        return fn(fakeTx);
      },
    );
    mocks.isLowBalance.mockRejectedValueOnce(new Error("DB timeout"));

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ suspended: 0, lowBalanceNotified: 0 });
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});
