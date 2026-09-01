import { describe, expect, it } from "vitest";
import { toolDeclarationPublish } from "./tool.declaration.publish";
import { getCapability } from "../registry";

const VALID_INPUT = {
  name: "read_file",
  description: "Read a file from the workspace",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
  risk_grade: "low",
  source: "builtin",
  manifest: { name: "read_file", version: "1.0.0" },
};

describe("tool.declaration.publish capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("publish_tool_declaration")).toBe(
      toolDeclarationPublish,
    );
  });

  it("is an api-only, high-sensitivity, default-deny governance write", () => {
    expect(toolDeclarationPublish.surfaces).toEqual(["api"]);
    expect(toolDeclarationPublish.sensitivity).toBe("high");
    expect(toolDeclarationPublish.defaultEffect).toBe("deny");
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts a valid declaration and defaults read_only to false", () => {
    const parsed = toolDeclarationPublish.input.parse(VALID_INPUT);
    expect(parsed.name).toBe("read_file");
    expect(parsed.read_only).toBe(false);
  });

  it("rejects a missing name", () => {
    const { name: _name, ...rest } = VALID_INPUT;
    expect(() => toolDeclarationPublish.input.parse(rest)).toThrow();
  });

  it("rejects an unknown risk grade", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({
        ...VALID_INPUT,
        risk_grade: "extreme",
      }),
    ).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({ ...VALID_INPUT, source: "plugin" }),
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      toolDeclarationPublish.input.parse({ ...VALID_INPUT, extra: true }),
    ).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = toolDeclarationPublish.output.parse({
      publicId: "tol_abc",
      slug: "read_file",
      version: 2,
      checksum: "a".repeat(64),
      published: true,
    });
    expect(parsed.version).toBe(2);
  });

  it("rejects a non-positive version", () => {
    expect(() =>
      toolDeclarationPublish.output.parse({
        publicId: "tol_abc",
        slug: "read_file",
        version: 0,
        checksum: "a".repeat(64),
        published: true,
      }),
    ).toThrow();
  });
});
