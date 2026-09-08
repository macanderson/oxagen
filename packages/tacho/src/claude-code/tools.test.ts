import { describe, expect, it } from "vitest";
import { classifyTool, commandHead } from "./tools";

describe("tool classification", () => {
  it("classifies builtin reads, writes, edits, commands, network, subagents, and skills", () => {
    expect(classifyTool("Read", { file_path: "/a" })).toMatchObject({
      effect_kind: "file_read",
      tool_is_mutating: false,
      tool_target: "/a",
    });
    expect(classifyTool("Grep", { pattern: "foo" })).toMatchObject({
      effect_kind: "file_read",
      tool_target: "foo",
    });
    expect(classifyTool("Write", { file_path: "/b" })).toMatchObject({
      effect_kind: "file_write",
      tool_is_mutating: true,
      tool_target: "/b",
    });
    expect(
      classifyTool("MultiEdit", {
        file_path: "/c",
        edits: [{ file_path: "/d" }, { file_path: "/c" }],
      }),
    ).toMatchObject({ effect_kind: "file_edit", tool_targets: ["/c", "/d"] });
    expect(
      classifyTool("NotebookEdit", { notebook_path: "/n.ipynb" }),
    ).toMatchObject({ effect_kind: "file_edit", tool_target: "/n.ipynb" });
    expect(
      classifyTool("Bash", { command: `echo ${"x".repeat(600)}` }),
    ).toMatchObject({ effect_kind: "command" });
    expect(classifyTool("Bash", { command: "ls" }).tool_target).toBe("ls");
    expect(classifyTool("Bash", {}).tool_target).toBeUndefined();
    expect(
      classifyTool("WebFetch", { url: "https://example.com/x?y" }),
    ).toMatchObject({
      effect_kind: "network",
      tool_target: "example.com",
      tool_is_mutating: false,
    });
    expect(classifyTool("WebFetch", { url: "not a url" })).toMatchObject({
      tool_target: "not a url",
    });
    expect(classifyTool("WebSearch", { query: "q" })).toMatchObject({
      tool_target: "q",
    });
    expect(classifyTool("Task", { subagent_type: "Explore" })).toMatchObject({
      effect_kind: "subagent",
      tool_target: "Explore",
    });
    expect(classifyTool("Skill", { skill: "review" })).toMatchObject({
      tool_source: "skill",
      tool_target: "review",
    });
    expect(classifyTool("TaskList", undefined)).toMatchObject({
      effect_kind: "other",
      tool_is_mutating: false,
    });
    expect(classifyTool("SomethingElse", {})).toMatchObject({
      effect_kind: "other",
      tool_is_mutating: true,
    });
  });

  it("splits MCP tools into server and tool and infers mutation from the verb", () => {
    expect(classifyTool("mcp__github__list_issues", {})).toMatchObject({
      tool_source: "mcp",
      mcp_server_name: "github",
      mcp_tool_name: "list_issues",
      tool_is_mutating: false,
    });
    expect(
      classifyTool("mcp__github__create_pull_request", {
        url: "https://api.github.com/x",
      }),
    ).toMatchObject({ tool_is_mutating: true, tool_target: "api.github.com" });
    expect(
      classifyTool("mcp__claude_ai_Gmail__send_message", {}),
    ).toMatchObject({
      mcp_server_name: "claude_ai_Gmail",
      mcp_tool_name: "send_message",
    });
  });

  it("extracts a command head", () => {
    expect(commandHead("  git push origin main")).toBe("git");
    expect(commandHead("./scripts/run.sh --x")).toBe("./scripts/run.sh");
    expect(commandHead("   ")).toBe("");
  });
});
