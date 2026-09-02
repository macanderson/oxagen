import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  syncInvoiceFromStripe: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    syncInvoiceFromStripe: mocks.syncInvoiceFromStripe,
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

await import("./stripe.sync-invoice");

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("stripeSyncInvoice Inngest handler", () => {
  beforeEach(() => {
    mocks.syncInvoiceFromStripe.mockReset();
    mocks.loggerInfo.mockClear();
    mocks.syncInvoiceFromStripe.mockResolvedValue(undefined);
  });

  it("calls syncInvoiceFromStripe with the correct Stripe invoice id", async () => {
    const event = { data: { stripeInvoiceId: "in_test_123" } };

    await capturedHandler!({ event, step: makeStep() });

    expect(mocks.syncInvoiceFromStripe).toHaveBeenCalledTimes(1);
    expect(mocks.syncInvoiceFromStripe).toHaveBeenCalledWith("in_test_123");
  });

  it("returns the synced invoice id", async () => {
    const event = { data: { stripeInvoiceId: "in_test_456" } };

    const result = await capturedHandler!({ event, step: makeStep() });

    const r = result as Record<string, unknown>;
    expect(r.synced).toBe("in_test_456");
  });

  it("logs completion with the invoice id", async () => {
    const event = { data: { stripeInvoiceId: "in_log_789" } };

    await capturedHandler!({ event, step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { stripeInvoiceId: "in_log_789" },
      "stripe.sync-invoice complete",
    );
  });

  it("propagates errors thrown by syncInvoiceFromStripe", async () => {
    mocks.syncInvoiceFromStripe.mockRejectedValueOnce(
      new Error("Stripe API error"),
    );
    const event = { data: { stripeInvoiceId: "in_fail_001" } };

    await expect(capturedHandler!({ event, step: makeStep() })).rejects.toThrow(
      "Stripe API error",
    );
  });
});
