// The tool family vocabulary, ported from the Run page's `groupOf` cases
// (apps/app/src/features/run/tool-detail.test.ts) when the vocabulary moved
// to the server (ADR-182).
import { describe, expect, it } from "vitest";
import { bareToolName, TOOL_FAMILIES, toolFamilyOf } from "./tool-family";

describe("toolFamilyOf", () => {
  it("reads a family from the name, whatever its case", () => {
    expect(toolFamilyOf("Bash")).toBe("shell");
    expect(toolFamilyOf("bash")).toBe("shell");
    expect(toolFamilyOf("Read")).toBe("read");
    expect(toolFamilyOf("Edit")).toBe("edit");
    expect(toolFamilyOf("MultiEdit")).toBe("edit");
    expect(toolFamilyOf("Write")).toBe("create");
    expect(toolFamilyOf("Grep")).toBe("search");
    expect(toolFamilyOf("Glob")).toBe("search");
    expect(toolFamilyOf("WebFetch")).toBe("web");
    expect(toolFamilyOf("Skill")).toBe("skill");
    expect(toolFamilyOf("Task")).toBe("agent");
    expect(toolFamilyOf("TodoWrite")).toBe("plan");
    expect(toolFamilyOf("NotebookEdit")).toBe("notebook");
    expect(toolFamilyOf("rm")).toBe("delete");
  });

  it("puts every MCP tool in the mcp family, whatever it is called", () => {
    expect(toolFamilyOf("mcp__github__list_issues")).toBe("mcp");
    expect(toolFamilyOf("mcp__anything__read")).toBe("mcp");
    expect(toolFamilyOf("mcp__github__get_file_contents")).toBe("mcp");
  });

  it("reads a prefixed or versioned tool by its own name", () => {
    expect(toolFamilyOf("claude_code__Bash")).toBe("shell");
    expect(toolFamilyOf("cursor__read_file")).toBe("read");
    expect(toolFamilyOf("write_file")).toBe("create");
    expect(toolFamilyOf("Read@2.1.4")).toBe("read");
  });

  it("falls back to the generic family (negative)", () => {
    expect(toolFamilyOf("SomethingNobodyKnows")).toBe("tool");
    expect(toolFamilyOf("")).toBe("tool");
    // A server prefix alone is not a known name: only `mcp__` marks MCP.
    expect(toolFamilyOf("github__list_pull_requests")).toBe("tool");
  });

  it("answers only families the vocabulary lists", () => {
    for (const name of ["Bash", "Unknown", "mcp__x__y", "Task"]) {
      expect(TOOL_FAMILIES).toContain(toolFamilyOf(name));
    }
  });
});

describe("bareToolName", () => {
  it("drops a harness prefix and a version, and keeps an MCP name whole", () => {
    expect(bareToolName("claude_code__Bash")).toBe("Bash");
    expect(bareToolName("Read@2.1.4")).toBe("Read");
    expect(bareToolName("mcp__github__create_release")).toBe(
      "mcp__github__create_release",
    );
    expect(bareToolName("Bash")).toBe("Bash");
  });
});
