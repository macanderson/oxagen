/**
 * enterprise.test.ts — unit tests for getEnterpriseAccess and assertEnterprise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted stubs
// ---------------------------------------------------------------------------
const { mockResolveOrgTier, mockMeetsMinimumTier, mockRequireTier } =
  vi.hoisted(() => {
    const mockResolveOrgTier = vi.fn();
    const mockMeetsMinimumTier = vi.fn();
    const mockRequireTier = vi.fn();
    return { mockResolveOrgTier, mockMeetsMinimumTier, mockRequireTier };
  });

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    resolveOrgTier: mockResolveOrgTier,
    meetsMinimumTier: mockMeetsMinimumTier,
    requireTier: mockRequireTier,
  };
});

import {
  getEnterpriseAccess,
  assertEnterprise,
  SOC2_MIN_TIER,
} from "./enterprise";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("SOC2_MIN_TIER", () => {
  it("is 'enterprise'", () => {
    expect(SOC2_MIN_TIER).toBe("enterprise");
  });
});

describe("getEnterpriseAccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns isEnterprise: true for an enterprise tier", async () => {
    mockResolveOrgTier.mockResolvedValue("enterprise");
    mockMeetsMinimumTier.mockReturnValue(true);
    const result = await getEnterpriseAccess("org-1");
    expect(result.tier).toBe("enterprise");
    expect(result.isEnterprise).toBe(true);
  });

  it("returns isEnterprise: false for a build tier", async () => {
    mockResolveOrgTier.mockResolvedValue("build");
    mockMeetsMinimumTier.mockReturnValue(false);
    const result = await getEnterpriseAccess("org-1");
    expect(result.tier).toBe("build");
    expect(result.isEnterprise).toBe(false);
  });

  it("returns isEnterprise: false for a free tier", async () => {
    mockResolveOrgTier.mockResolvedValue("free");
    mockMeetsMinimumTier.mockReturnValue(false);
    const result = await getEnterpriseAccess("org-1");
    expect(result.tier).toBe("free");
    expect(result.isEnterprise).toBe(false);
  });

  it("calls meetsMinimumTier with the resolved tier and SOC2_MIN_TIER", async () => {
    mockResolveOrgTier.mockResolvedValue("scale");
    mockMeetsMinimumTier.mockReturnValue(false);
    await getEnterpriseAccess("org-1");
    expect(mockMeetsMinimumTier).toHaveBeenCalledWith("scale", SOC2_MIN_TIER);
  });
});

describe("assertEnterprise", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls requireTier with the resolved tier, SOC2_MIN_TIER, and feature name", async () => {
    mockResolveOrgTier.mockResolvedValue("enterprise");
    mockRequireTier.mockReturnValue(undefined); // no-op for allowed tiers
    await assertEnterprise("org-1", "audit-export");
    expect(mockRequireTier).toHaveBeenCalledWith(
      "enterprise",
      SOC2_MIN_TIER,
      "audit-export",
    );
  });

  it("propagates when requireTier throws (insufficient tier)", async () => {
    mockResolveOrgTier.mockResolvedValue("free");
    const err = new Error("TierDenied: requires enterprise");
    mockRequireTier.mockImplementation(() => {
      throw err;
    });
    await expect(assertEnterprise("org-1", "soc2-export")).rejects.toThrow(
      "TierDenied",
    );
  });
});
