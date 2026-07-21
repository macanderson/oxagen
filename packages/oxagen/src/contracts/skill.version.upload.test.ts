import { describe, expect, it } from "vitest";
import { skillVersionUpload } from "./skill.version.upload";
import { getCapability } from "../registry";

describe("skill.version.upload capability", () => {
  // ── input: required fields ─────────────────────────────────────────────────

  it("parses valid input with skill_id and content", () => {
    const parsed = skillVersionUpload.input.parse({
      skill_id: "skl_abc123",
      content: 'schema_version = 1\nkind = "skill"',
    });
    expect(parsed.skill_id).toBe("skl_abc123");
    expect(parsed.content).toContain("schema_version");
  });

  it("defaults activate to true when omitted", () => {
    const parsed = skillVersionUpload.input.parse({
      skill_id: "skl_abc",
      content: "content",
    });
    expect(parsed.activate).toBe(true);
  });

  it("accepts explicit activate=false", () => {
    const parsed = skillVersionUpload.input.parse({
      skill_id: "skl_abc",
      content: "content",
      activate: false,
    });
    expect(parsed.activate).toBe(false);
  });

  it("accepts an optional workspace_id", () => {
    const parsed = skillVersionUpload.input.parse({
      skill_id: "skl_abc",
      content: "content",
      workspace_id: "ws_123",
    });
    expect(parsed.workspace_id).toBe("ws_123");
  });

  // ── input: validation ──────────────────────────────────────────────────────

  it("rejects missing skill_id", () => {
    expect(() =>
      skillVersionUpload.input.parse({ content: "content" }),
    ).toThrow();
  });

  it("rejects missing content", () => {
    expect(() =>
      skillVersionUpload.input.parse({ skill_id: "skl_abc" }),
    ).toThrow();
  });

  it("rejects empty content", () => {
    expect(() =>
      skillVersionUpload.input.parse({ skill_id: "skl_abc", content: "" }),
    ).toThrow();
  });

  it("rejects a non-string skill_id", () => {
    expect(() =>
      skillVersionUpload.input.parse({ skill_id: 42, content: "content" }),
    ).toThrow();
  });

  // ── output shape ───────────────────────────────────────────────────────────

  it("parses valid output", () => {
    const parsed = skillVersionUpload.output.parse({
      version_id: "slv_abc",
      version_number: 2,
      skill_id: "skl_abc123",
      activated: true,
    });
    expect(parsed.version_id).toBe("slv_abc");
    expect(parsed.version_number).toBe(2);
    expect(parsed.skill_id).toBe("skl_abc123");
    expect(parsed.activated).toBe(true);
  });

  it("rejects output missing version_id", () => {
    expect(() =>
      skillVersionUpload.output.parse({
        version_number: 2,
        skill_id: "skl_abc",
        activated: true,
      }),
    ).toThrow();
  });

  it("rejects output with a non-integer version_number", () => {
    expect(() =>
      skillVersionUpload.output.parse({
        version_id: "slv_abc",
        version_number: 1.5,
        skill_id: "skl_abc",
        activated: true,
      }),
    ).toThrow();
  });

  // ── registry ───────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("upload_skill_version")).toBe(skillVersionUpload);
  });

  it("has the correct name", () => {
    expect(skillVersionUpload.name).toBe("upload_skill_version");
  });

  it("is scoped", () => {
    expect(skillVersionUpload.scoped).toBe(true);
  });

  it("surfaces include api and mcp", () => {
    expect(skillVersionUpload.surfaces).toContain("api");
    expect(skillVersionUpload.surfaces).toContain("mcp");
  });
});
