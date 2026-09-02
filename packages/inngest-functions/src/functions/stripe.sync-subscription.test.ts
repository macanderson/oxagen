import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  syncSubscriptionFromStripe: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    syncSubscriptionFromStripe: mocks.syncSubscriptionFromStripe,
  };
});

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, error: vi.fn() },
}));

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    INNGEST_EVENT_KEY: "evt-test",
    INNGEST_SIGNING_KEY: "sign-test",
    NODE_ENV: "test",
  }),
  normalizeEnv: (e: unknown) => e,
}));

// Capture the handler
let capturedHandler:
  | ((ctx: {
      event: { data: Record<string, unknown> };
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
  },
);

await import("./stripe.sync-subscription");

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("stripeSyncSubscription Inngest handler", () => {
  beforeEach(() => {
    mocks.syncSubscriptionFromStripe.mockReset();
    mocks.loggerInfo.mockClear();
    mocks.syncSubscriptionFromStripe.mockResolvedValue(undefined);
  });

  it("calls syncSubscriptionFromStripe with the correct Stripe subscription id", async () => {
    const event = { data: { stripeSubscriptionId: "sub_test_123" } };

    await capturedHandler!({ event, step: makeStep() });

    expect(mocks.syncSubscriptionFromStripe).toHaveBeenCalledTimes(1);
    expect(mocks.syncSubscriptionFromStripe).toHaveBeenCalledWith(
      "sub_test_123",
    );
  });

  it("returns the synced subscription id", async () => {
    const event = { data: { stripeSubscriptionId: "sub_test_456" } };

    const result = await capturedHandler!({ event, step: makeStep() });

    const r = result as Record<string, unknown>;
    expect(r.synced).toBe("sub_test_456");
  });

  it("logs completion with the subscription id", async () => {
    const event = { data: { stripeSubscriptionId: "sub_log_789" } };

    await capturedHandler!({ event, step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { stripeSubscriptionId: "sub_log_789" },
      "stripe.sync-subscription complete",
    );
  });

  it("propagates errors thrown by syncSubscriptionFromStripe", async () => {
    mocks.syncSubscriptionFromStripe.mockRejectedValueOnce(
      new Error("Stripe API error"),
    );
    const event = { data: { stripeSubscriptionId: "sub_fail_001" } };

    await expect(capturedHandler!({ event, step: makeStep() })).rejects.toThrow(
      "Stripe API error",
    );
  });
});
