import { describe, it, expect } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { toolAllowedForAgent, filterToolsForAgent } from "../tools.js";

describe("toolAllowedForAgent", () => {
  it("inherits everything when the allowlist is undefined", () => {
    expect(toolAllowedForAgent("bash", undefined)).toBe(true);
  });

  it("requires canonical exact names", () => {
    expect(toolAllowedForAgent("read_file", ["read_file"])).toBe(true);
    expect(toolAllowedForAgent("read_file", ["Read"])).toBe(false);
    expect(toolAllowedForAgent("bash", ["bash"])).toBe(true);
  });

  it("matches the raw tool name too", () => {
    expect(toolAllowedForAgent("write_file", ["write_file"])).toBe(true);
  });

  it("does not authorize wildcard MCP aliases", () => {
    expect(
      toolAllowedForAgent("mcp__github__create_issue", ["mcp__github__*"]),
    ).toBe(false);
    expect(toolAllowedForAgent("mcp__other__x", ["mcp__github__*"])).toBe(
      false,
    );
  });
});

describe("filterToolsForAgent", () => {
  const make = (): ToolSet => ({
    read_file: tool({
      description: "",
      inputSchema: z.object({}),
      execute: async () => "",
    }),
    bash: tool({
      description: "",
      inputSchema: z.object({}),
      execute: async () => "",
    }),
    mcp__github__create_issue: tool({
      description: "",
      inputSchema: z.object({}),
      execute: async () => "",
    }),
  });

  it("returns the same set when no allowlist", () => {
    const t = make();
    expect(filterToolsForAgent(t, undefined)).toBe(t);
  });

  it("keeps only allowed tools", () => {
    const filtered = filterToolsForAgent(make(), [
      "read_file",
      "mcp__github__create_issue",
    ]);
    expect(Object.keys(filtered).sort()).toEqual([
      "mcp__github__create_issue",
      "read_file",
    ]);
    expect(filtered).not.toHaveProperty("bash");
  });
});
