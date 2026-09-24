// The slug Create a workspace makes from a name: the contract's one spelling
// (packages/oxagen/src/workspace-slug.ts), so a name a person types becomes a
// slug `create_workspace` accepts, or one it refuses on its own terms.
import { describe, expect, it } from "vitest";
import { slugFromName } from "./workspace-slug";

describe("slugFromName", () => {
  it("spells the contract's one slug shape: lowercase groups joined by single hyphens", () => {
    expect(slugFromName("Core platform")).toBe("core-platform");
    expect(slugFromName("  FinOps / Billing -- EU ")).toBe("finops-billing-eu");
    expect(slugFromName("Équipe données")).toBe("equipe-donnees");
    expect(slugFromName("---")).toBe("");
  });

  it("cuts at 40 characters with no trailing hyphen", () => {
    const slug = slugFromName(`${"a".repeat(39)} b`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});
