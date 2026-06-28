import { describe, it, expect } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { toolAllowedForAgent, filterToolsForAgent } from "../tools.js";

describe("toolAllowedForAgent", () => {
  it("inherits everything when the allowlist is undefined", () => {
    expect(toolAllowedForAgent("bash", undefined)).toBe(true);
  });

  it("matches local tools by canonical name", () => {
    // Read covers read_file/grep/glob/list_dir/code_graph
    expect(toolAllowedForAgent("read_file", ["Read"])).toBe(true);
    expect(toolAllowedForAgent("grep", ["Read"])).toBe(true);
    expect(toolAllowedForAgent("bash", ["Read"])).toBe(false);
    expect(toolAllowedForAgent("bash", ["Bash"])).toBe(true);
  });

  it("matches the raw tool name too", () => {
    expect(toolAllowedForAgent("write_file", ["write_file"])).toBe(true);
  });

  it("globs MCP tool names", () => {
    expect(toolAllowedForAgent("mcp__github__create_issue", ["mcp__github__*"])).toBe(true);
    expect(toolAllowedForAgent("mcp__other__x", ["mcp__github__*"])).toBe(false);
  });
});

describe("filterToolsForAgent", () => {
  const make = (): ToolSet => ({
    read_file: tool({ description: "", inputSchema: z.object({}), execute: async () => "" }),
    bash: tool({ description: "", inputSchema: z.object({}), execute: async () => "" }),
    mcp__github__create_issue: tool({ description: "", inputSchema: z.object({}), execute: async () => "" }),
  });

  it("returns the same set when no allowlist", () => {
    const t = make();
    expect(filterToolsForAgent(t, undefined)).toBe(t);
  });

  it("keeps only allowed tools", () => {
    const filtered = filterToolsForAgent(make(), ["Read", "mcp__github__*"]);
    expect(Object.keys(filtered).sort()).toEqual(["mcp__github__create_issue", "read_file"]);
    expect(filtered).not.toHaveProperty("bash");
  });
});
