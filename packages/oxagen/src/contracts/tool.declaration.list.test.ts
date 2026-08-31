import { describe, expect, it } from "vitest";
import { toolDeclarationList } from "./tool.declaration.list";
import { getCapability } from "../registry";

describe("tool.declaration.list capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("list_tool_declarations")).toBe(toolDeclarationList);
  });

  it("is exposed on the api, agent, and mcp surfaces", () => {
    expect(toolDeclarationList.surfaces).toEqual(["api", "agent", "mcp"]);
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("applies default limit 50 and offset 0", () => {
    const parsed = toolDeclarationList.input.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it("accepts a source filter", () => {
    const parsed = toolDeclarationList.input.parse({ source: "mcp" });
    expect(parsed.source).toBe("mcp");
  });

  it("rejects an unknown source filter", () => {
    expect(() =>
      toolDeclarationList.input.parse({ source: "plugin" }),
    ).toThrow();
  });

  it("rejects limit exceeding 200", () => {
    expect(() => toolDeclarationList.input.parse({ limit: 201 })).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a valid output with one declaration", () => {
    const parsed = toolDeclarationList.output.parse({
      tools: [
        {
          id: "tol_abc",
          slug: "read_file",
          name: "read_file",
          description: "Read a file",
          source: "builtin",
          enabled: true,
          readOnly: true,
          riskGrade: "low",
          policyGroup: null,
          version: 1,
          checksum: "a".repeat(64),
          updatedAt: new Date(0).toISOString(),
        },
      ],
      total: 1,
    });
    expect(parsed.tools).toHaveLength(1);
  });

  it("allows null version facts when no version is pinned", () => {
    const parsed = toolDeclarationList.output.parse({
      tools: [
        {
          id: "tol_abc",
          slug: "read_file",
          name: "read_file",
          description: null,
          source: "custom",
          enabled: false,
          readOnly: null,
          riskGrade: null,
          policyGroup: null,
          version: null,
          checksum: null,
          updatedAt: new Date(0).toISOString(),
        },
      ],
      total: 1,
    });
    expect(parsed.tools[0]?.version).toBeNull();
  });
});
