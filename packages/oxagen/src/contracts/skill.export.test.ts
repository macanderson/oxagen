import { describe, expect, it } from "vitest";
import { skillExport } from "./skill.export";
import { getCapability } from "../registry";

describe("skill.export capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts a skillId without versionNumber", () => {
    const parsed = skillExport.input.parse({ skillId: "skl_abc123" });
    expect(parsed.skillId).toBe("skl_abc123");
    expect(parsed.versionNumber).toBeUndefined();
  });

  it("accepts a skillId with versionNumber", () => {
    const parsed = skillExport.input.parse({
      skillId: "skl_abc123",
      versionNumber: 3,
    });
    expect(parsed.skillId).toBe("skl_abc123");
    expect(parsed.versionNumber).toBe(3);
  });

  it("rejects missing skillId", () => {
    expect(() => skillExport.input.parse({})).toThrow();
  });

  it("rejects non-string skillId", () => {
    expect(() => skillExport.input.parse({ skillId: 42 })).toThrow();
  });

  it("rejects non-integer versionNumber", () => {
    expect(() =>
      skillExport.input.parse({ skillId: "skl_abc", versionNumber: 1.5 }),
    ).toThrow();
  });

  it("rejects zero versionNumber", () => {
    expect(() =>
      skillExport.input.parse({ skillId: "skl_abc", versionNumber: 0 }),
    ).toThrow();
  });

  it("rejects negative versionNumber", () => {
    expect(() =>
      skillExport.input.parse({ skillId: "skl_abc", versionNumber: -1 }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = skillExport.output.parse({
      filename: "my-skill.toml",
      content: 'schema_version = 1\nkind = "skill"\nname = "my-skill"\n',
      versionNumber: 2,
    });
    expect(parsed.filename).toBe("my-skill.toml");
    expect(parsed.content).toContain("schema_version");
    expect(parsed.versionNumber).toBe(2);
  });

  it("rejects output missing filename", () => {
    expect(() =>
      skillExport.output.parse({
        content: 'schema_version = 1\nkind = "skill"\n',
        versionNumber: 1,
      }),
    ).toThrow();
  });

  it("rejects output missing content", () => {
    expect(() =>
      skillExport.output.parse({ filename: "x.toml", versionNumber: 1 }),
    ).toThrow();
  });

  it("rejects output missing versionNumber", () => {
    expect(() =>
      skillExport.output.parse({
        filename: "x.toml",
        content: 'schema_version = 1\nkind = "skill"\n',
      }),
    ).toThrow();
  });

  it("rejects non-positive versionNumber in output", () => {
    expect(() =>
      skillExport.output.parse({
        filename: "x.toml",
        content: 'schema_version = 1\nkind = "skill"\n',
        versionNumber: 0,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("export_skill")).toBe(skillExport);
  });

  it("has noBillingGate set", () => {
    expect(skillExport.noBillingGate).toBe(true);
  });
});
