/**
 * bootstrap.test.ts — bootstrapEntitlementRuntime
 *
 * Covers:
 *  - bootstrapEntitlementRuntime calls setCapabilityEntitlementGate on first call
 *  - bootstrapEntitlementRuntime is idempotent (second call is a no-op)
 *  - The registered gate function delegates to capabilityEntitlementGate
 *
 * Mirrors packages/billing/src/bootstrap.test.ts in style.
 * vi.resetModules() in beforeEach resets the module-level `booted` flag.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Top-level mocks are hoisted by vitest — they apply to all dynamic imports.

const setCapabilityEntitlementGateMock = vi.fn();
vi.mock("@oxagen/oxagen/kernel", () => ({
  setCapabilityEntitlementGate: setCapabilityEntitlementGateMock,
}));

const capabilityEntitlementGateMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./entitlement-service", () => ({
  capabilityEntitlementGate: capabilityEntitlementGateMock,
}));

describe("bootstrapEntitlementRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls setCapabilityEntitlementGate once", async () => {
    const { bootstrapEntitlementRuntime } = await import("./bootstrap");
    bootstrapEntitlementRuntime();
    expect(setCapabilityEntitlementGateMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call does not call setCapabilityEntitlementGate again", async () => {
    const { bootstrapEntitlementRuntime } = await import("./bootstrap");
    bootstrapEntitlementRuntime();
    bootstrapEntitlementRuntime();
    // Still only 1 call total (module-level booted flag prevents re-registration).
    expect(setCapabilityEntitlementGateMock).toHaveBeenCalledTimes(1);
  });

  it("the registered gate function delegates to capabilityEntitlementGate", async () => {
    const { bootstrapEntitlementRuntime } = await import("./bootstrap");
    bootstrapEntitlementRuntime();
    const gateFn = setCapabilityEntitlementGateMock.mock.calls[0]?.[0] as
      | ((capabilityName: string, orgId: string) => Promise<void>)
      | undefined;
    expect(gateFn).toBeDefined();
    await gateFn!("generate_svg", "org-test");
    expect(capabilityEntitlementGateMock).toHaveBeenCalledWith(
      "generate_svg",
      "org-test",
    );
  });
});
