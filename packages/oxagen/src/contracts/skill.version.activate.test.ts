import { describe, expect, it } from "vitest";
import { skillVersionActivate } from "./skill.version.activate";
import { getCapability } from "../registry";

describe("skill.version.activate capability", () => {
  // ── input: required fields ─────────────────────────────────────────────────

  it("parses valid input with skillId and versionNumber", () => {
    const parsed = skillVersionActivate.input.parse({
      skillId: "skl_abc123",
      versionNumber: 3,
    });
    expect(parsed.skillId).toBe("skl_abc123");
    expect(parsed.versionNumber).toBe(3);
  });

  it("accepts versionNumber of 1 (minimum)", () => {
    const parsed = skillVersionActivate.input.parse({
      skillId: "skl_xyz",
      versionNumber: 1,
    });
    expect(parsed.versionNumber).toBe(1);
  });

  // ── input: validation ──────────────────────────────────────────────────────

  it("rejects missing skillId", () => {
    expect(() =>
      skillVersionActivate.input.parse({ versionNumber: 2 }),
    ).toThrow();
  });

  it("rejects missing versionNumber", () => {
    expect(() =>
      skillVersionActivate.input.parse({ skillId: "skl_abc" }),
    ).toThrow();
  });

  it("rejects versionNumber of 0 (below minimum)", () => {
    expect(() =>
      skillVersionActivate.input.parse({
        skillId: "skl_abc",
        versionNumber: 0,
      }),
    ).toThrow();
  });

  it("rejects non-integer versionNumber", () => {
    expect(() =>
      skillVersionActivate.input.parse({
        skillId: "skl_abc",
        versionNumber: 1.5,
      }),
    ).toThrow();
  });

  it("rejects non-string skillId", () => {
    expect(() =>
      skillVersionActivate.input.parse({ skillId: 42, versionNumber: 1 }),
    ).toThrow();
  });

  // ── output shape ───────────────────────────────────────────────────────────

  it("parses valid output", () => {
    const parsed = skillVersionActivate.output.parse({
      skillId: "skl_abc123",
      activeVersionNumber: 3,
      activatedAt: "2026-06-18T10:00:00.000Z",
    });
    expect(parsed.skillId).toBe("skl_abc123");
    expect(parsed.activeVersionNumber).toBe(3);
    expect(parsed.activatedAt).toBe("2026-06-18T10:00:00.000Z");
  });

  it("rejects output missing skillId", () => {
    expect(() =>
      skillVersionActivate.output.parse({
        activeVersionNumber: 3,
        activatedAt: "2026-06-18T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing activeVersionNumber", () => {
    expect(() =>
      skillVersionActivate.output.parse({
        skillId: "skl_abc",
        activatedAt: "2026-06-18T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing activatedAt", () => {
    expect(() =>
      skillVersionActivate.output.parse({
        skillId: "skl_abc",
        activeVersionNumber: 2,
      }),
    ).toThrow();
  });

  // ── registry ───────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("activate_skill_version")).toBe(skillVersionActivate);
  });

  it("has the correct name", () => {
    expect(skillVersionActivate.name).toBe("activate_skill_version");
  });

  it("is scoped", () => {
    expect(skillVersionActivate.scoped).toBe(true);
  });

  it("surfaces include api and mcp", () => {
    expect(skillVersionActivate.surfaces).toContain("api");
    expect(skillVersionActivate.surfaces).toContain("mcp");
  });
});
