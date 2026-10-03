// The slug Create a workspace makes from a name: the contract's one spelling
// (packages/oxagen/src/workspace-slug.ts), so a name a person types becomes a
// slug `create_workspace` accepts, or one it refuses on its own terms.
import { describe, expect, it } from "vitest";
import { slugDraft, slugFromName, slugProblem } from "./workspace-slug";

describe("slugDraft", () => {
  it("keeps lowercase letters, digits and hyphens, and turns a space into a hyphen", () => {
    expect(slugDraft("Core Platform")).toBe("core-platform");
    expect(slugDraft("R&D / EU")).toBe("rd-eu");
    expect(slugDraft("a  --  b")).toBe("a-b");
  });

  it("keeps a hyphen at the end, so the next word can follow it", () => {
    expect(slugDraft("core-")).toBe("core-");
  });

  it("stops at 40 characters", () => {
    expect(slugDraft("a".repeat(50))).toHaveLength(40);
  });
});

describe("slugProblem", () => {
  it("takes a slug create_workspace takes", () => {
    expect(slugProblem("core-platform")).toBeNull();
  });

  it("names a slug too short, the wrong shape, or reserved (negative)", () => {
    expect(slugProblem("a")).toBe("short");
    expect(slugProblem("core-")).toBe("shape");
    expect(slugProblem("-core")).toBe("shape");
    expect(slugProblem("settings")).toBe("reserved");
  });
});

describe("slugFromName", () => {
  it("spells the contract's one slug shape: lowercase groups joined by single hyphens", () => {
    expect(slugFromName("Core platform")).toBe("core-platform");
    expect(slugFromName("  FinOps / Billing -- EU ")).toBe("finops-billing-eu");
    expect(slugFromName("Équipe données")).toBe("equipe-donnees");
    expect(slugFromName("---")).toBe("");
  });

  it("drops apostrophes and other special characters (ADR-198)", () => {
    expect(slugFromName("Mac's team")).toBe("macs-team");
    expect(slugFromName("R&D")).toBe("rd");
  });

  it("cuts at 40 characters with no trailing hyphen", () => {
    const slug = slugFromName(`${"a".repeat(39)} b`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});
