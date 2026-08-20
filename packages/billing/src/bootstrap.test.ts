/**
 * Unit tests for bootstrap.ts — bootstrapBillingRuntime.
 *
 * Covers:
 *  - bootstrapBillingRuntime calls setBillingAdmissionGate on first call
 *  - bootstrapBillingRuntime is idempotent (second call is a no-op)
 *  - The gate function delegate calls assertCanStartTurn
 *
 * Each test gets a fresh module import so the `booted` module-level flag is
 * reset between tests. vi.resetModules() is called in beforeEach to ensure
 * the module cache is cleared and the mock factories run again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Top-level mocks are hoisted by vitest — they apply to all dynamic imports.
const setBillingAdmissionGateMock = vi.fn();
const setBudgetAdmissionGateMock = vi.fn();
vi.mock("@oxagen/oxagen/kernel", () => ({
  setBillingAdmissionGate: setBillingAdmissionGateMock,
  setBudgetAdmissionGate: setBudgetAdmissionGateMock,
}));

const assertCanStartTurnMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./metering", () => ({
  assertCanStartTurn: assertCanStartTurnMock,
}));

const assertWithinSpendBudgetMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./spend-budget-gate", () => ({
  assertWithinSpendBudget: assertWithinSpendBudgetMock,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe("bootstrapBillingRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls setBillingAdmissionGate once", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    expect(setBillingAdmissionGateMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call does not call setBillingAdmissionGate again", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    bootstrapBillingRuntime();
    // Still only 1 call total (module-level booted flag prevents re-registration).
    expect(setBillingAdmissionGateMock).toHaveBeenCalledTimes(1);
  });

  it("the registered gate delegates to assertCanStartTurn", async () => {
    const { bootstrapBillingRuntime } = await import("./bootstrap");
    bootstrapBillingRuntime();
    // The gate function was registered in the call above — extract it.
    const gateFn = setBillingAdmissionGateMock.mock.calls[0]?.[0] as
      | ((orgId: string) => Promise<void>)
      | undefined;
    expect(gateFn).toBeDefined();
    await gateFn!("org-test");
    expect(assertCanStartTurnMock).toHaveBeenCalledWith("org-test");
  });
});
