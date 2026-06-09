/**
 * Unit tests for bootstrap.ts — bootstrapBillingRuntime.
 *
 * Covers:
 *  - bootstrapBillingRuntime calls setBillingAdmissionGate on first call
 *  - bootstrapBillingRuntime is idempotent (second call is a no-op)
 *  - The gate function delegate calls assertCanStartTurn
 */
import { describe, it, expect, vi } from "vitest";

const setBillingAdmissionGateMock = vi.fn();

vi.mock("@oxagen/oxagen/kernel", () => ({
  setBillingAdmissionGate: setBillingAdmissionGateMock,
}));

const assertCanStartTurnMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./metering", () => ({
  assertCanStartTurn: assertCanStartTurnMock,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Each test imports a fresh module (vi.resetModules between tests would be
// needed for true isolation of the `booted` flag, but since the module is
// cached we just verify idempotency by inspecting call counts).
const { bootstrapBillingRuntime } = await import("./bootstrap");

describe("bootstrapBillingRuntime", () => {
  it("calls setBillingAdmissionGate once", () => {
    bootstrapBillingRuntime();
    expect(setBillingAdmissionGateMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call does not call setBillingAdmissionGate again", () => {
    bootstrapBillingRuntime();
    bootstrapBillingRuntime();
    // Still only 1 call total (module-level booted flag prevents re-registration).
    expect(setBillingAdmissionGateMock).toHaveBeenCalledTimes(1);
  });

  it("the registered gate delegates to assertCanStartTurn", async () => {
    // The gate function was registered in the call above — extract it.
    const gateFn = setBillingAdmissionGateMock.mock.calls[0]?.[0] as
      | ((orgId: string) => Promise<void>)
      | undefined;
    expect(gateFn).toBeDefined();
    await gateFn!("org-test");
    expect(assertCanStartTurnMock).toHaveBeenCalledWith("org-test");
  });
});
