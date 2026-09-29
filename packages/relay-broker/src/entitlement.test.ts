// entitlement.ts: a relay credential needs the Enterprise plan.
import { beforeEach, describe, expect, it, vi } from "vitest";

const billing = vi.hoisted(() => ({
  meetsMinimumTier: vi.fn((actual: string, minimum: string) => actual === minimum),
  resolveOrgTier: vi.fn(async (_orgId: string) => "enterprise"),
}));

vi.mock("@oxagen/billing", () => billing);

import { relayCredentialEntitled } from "./entitlement";

describe("relayCredentialEntitled", () => {
  beforeEach(() => {
    billing.meetsMinimumTier.mockClear();
    billing.resolveOrgTier.mockClear();
  });

  it("uses the plan tier the caller already resolved, with no lookup", async () => {
    expect(await relayCredentialEntitled("org-1", "enterprise")).toBe(true);
    expect(await relayCredentialEntitled("org-1", "scale")).toBe(false);
    expect(billing.resolveOrgTier).not.toHaveBeenCalled();
    expect(billing.meetsMinimumTier).toHaveBeenCalledWith("scale", "enterprise");
  });

  it("looks the tier up when the caller has none", async () => {
    expect(await relayCredentialEntitled("org-1", undefined)).toBe(true);
    expect(billing.resolveOrgTier).toHaveBeenCalledWith("org-1");
    expect(billing.meetsMinimumTier).toHaveBeenCalledWith("enterprise", "enterprise");
  });

  it("refuses when the looked-up tier is below Enterprise", async () => {
    billing.resolveOrgTier.mockResolvedValueOnce("build");
    expect(await relayCredentialEntitled("org-2", undefined)).toBe(false);
  });

  it("passes a failed lookup to the caller, which refuses the call", async () => {
    billing.resolveOrgTier.mockRejectedValueOnce(new Error("database down"));
    await expect(relayCredentialEntitled("org-3", undefined)).rejects.toThrow("database down");
  });
});
