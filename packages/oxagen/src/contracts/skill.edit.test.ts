import { describe, expect, it } from "vitest";
import { skillEdit } from "./skill.edit";
import { getCapability } from "../registry";

describe("skill.edit capability", () => {
  // ── input: required fields ─────────────────────────────────────────────────

  it("parses valid input with skill_id and content", () => {
    const parsed = skillEdit.input.parse({
      skill_id: "skl_abc123",
      content: 'schema_version = 1\nkind = "skill"',
    });
    expect(parsed.skill_id).toBe("skl_abc123");
    expect(parsed.content).toContain("schema_version");
  });

  it("defaults activate to true when omitted", () => {
    const parsed = skillEdit.input.parse({
      skill_id: "skl_abc",
      content: "content",
    });
    expect(parsed.activate).toBe(true);
  });

  it("accepts explicit activate=false", () => {
    const parsed = skillEdit.input.parse({
      skill_id: "skl_abc",
      content: "content",
      activate: false,
    });
    expect(parsed.activate).toBe(false);
  });

  it("accepts an optional workspace_id", () => {
    const parsed = skillEdit.input.parse({
      skill_id: "skl_abc",
      content: "content",
      workspace_id: "ws_123",
    });
    expect(parsed.workspace_id).toBe("ws_123");
  });

  // ── input: validation ──────────────────────────────────────────────────────

  it("rejects missing skill_id", () => {
    expect(() => skillEdit.input.parse({ content: "content" })).toThrow();
  });

  it("rejects missing content", () => {
    expect(() => skillEdit.input.parse({ skill_id: "skl_abc" })).toThrow();
  });

  it("rejects empty content", () => {
    expect(() =>
      skillEdit.input.parse({ skill_id: "skl_abc", content: "" }),
    ).toThrow();
  });

  it("rejects a non-string skill_id", () => {
    expect(() =>
      skillEdit.input.parse({ skill_id: 42, content: "content" }),
    ).toThrow();
  });

  // ── output shape ───────────────────────────────────────────────────────────

  it("parses valid output", () => {
    const parsed = skillEdit.output.parse({
      version_id: "slv_abc",
      version_number: 3,
      skill_id: "skl_abc123",
      activated: true,
    });
    expect(parsed.version_id).toBe("slv_abc");
    expect(parsed.version_number).toBe(3);
    expect(parsed.skill_id).toBe("skl_abc123");
    expect(parsed.activated).toBe(true);
  });

  it("rejects output missing version_id", () => {
    expect(() =>
      skillEdit.output.parse({
        version_number: 3,
        skill_id: "skl_abc",
        activated: true,
      }),
    ).toThrow();
  });

  it("rejects output with a non-integer version_number", () => {
    expect(() =>
      skillEdit.output.parse({
        version_id: "slv_abc",
        version_number: 2.5,
        skill_id: "skl_abc",
        activated: true,
      }),
    ).toThrow();
  });

  // ── registry ───────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("edit_skill")).toBe(skillEdit);
  });

  it("has the correct name", () => {
    expect(skillEdit.name).toBe("edit_skill");
  });

  it("is scoped", () => {
    expect(skillEdit.scoped).toBe(true);
  });

  it("surfaces include api and mcp", () => {
    expect(skillEdit.surfaces).toContain("api");
    expect(skillEdit.surfaces).toContain("mcp");
  });
});
