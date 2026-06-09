import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  sweepDunning: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    sweepDunning: mocks.sweepDunning,
  };
});

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

// Capture the handler at module-load time (same pattern as sibling tests).
let capturedHandler: ((ctx: {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>) | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
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
    mocks.loggerInfo.mockClear();
  });

  it("calls sweepDunning once per invocation", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 0 });

    await capturedHandler!({ step: makeStep() });

    expect(mocks.sweepDunning).toHaveBeenCalledTimes(1);
  });

  it("returns the result produced by sweepDunning", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 3 });

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ suspended: 3 });
  });

  it("logs completion with the suspended count", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 7 });

    await capturedHandler!({ step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { suspended: 7 },
      "billing.dunning-sweep complete",
    );
  });

  it("logs zero when no orgs are suspended", async () => {
    mocks.sweepDunning.mockResolvedValue({ suspended: 0 });

    await capturedHandler!({ step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { suspended: 0 },
      "billing.dunning-sweep complete",
    );
  });

  it("propagates errors thrown by sweepDunning", async () => {
    mocks.sweepDunning.mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(capturedHandler!({ step: makeStep() })).rejects.toThrow("DB connection lost");
  });
});
