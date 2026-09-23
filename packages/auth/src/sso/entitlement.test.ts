import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveOrgTier } = vi.hoisted(() => ({ resolveOrgTier: vi.fn() }));
vi.mock("@oxagen/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/billing")>()),
  resolveOrgTier,
}));

const { orgHasSso } = await import("./entitlement");

describe("orgHasSso", () => {
  beforeEach(() => resolveOrgTier.mockReset());

  it("is true on the Enterprise plan", async () => {
    resolveOrgTier.mockResolvedValue("enterprise");
    await expect(orgHasSso("org_1")).resolves.toBe(true);
    expect(resolveOrgTier).toHaveBeenCalledWith("org_1");
  });

  it.each(["free", "build", "scale"])("is false on %s", async (tier) => {
    resolveOrgTier.mockResolvedValue(tier);
    await expect(orgHasSso("org_1")).resolves.toBe(false);
  });
});
