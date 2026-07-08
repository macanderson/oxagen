/**
 * Tool formatter — proves the CLI renders tool calls as pretty, human-readable
 * one-liners (`edit(a.ts)`, `bash(git push)`) and NEVER dumps the raw JSON
 * argument object at the user.
 */
import { describe, it, expect } from "vitest";
import {
  formatToolArgs,
  formatToolCall,
  getToolEmoji,
  getToolAccent,
  toolDisplayLabel,
  isSubagentDispatch,
  subagentInfo,
} from "../tool-formatter.js";

describe("formatToolArgs", () => {
  it("shows the file path for file operations (not the whole object)", () => {
    expect(formatToolArgs("Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" })).toBe(
      "src/a.ts",
    );
    expect(formatToolArgs("Read", { path: "README.md" })).toBe("README.md");
    expect(formatToolArgs("Write", { file: "out.txt", content: "…" })).toBe("out.txt");
  });

  it("shows the command for shell execution", () => {
    expect(formatToolArgs("Bash", { command: "git push origin main" })).toBe("git push origin main");
  });

  it("shows the query/pattern for search tools", () => {
    expect(formatToolArgs("Grep", { pattern: "TODO", path: "src" })).toBe("TODO");
    expect(formatToolArgs("knowledge.query", { query: "who owns billing" })).toBe(
      "who owns billing",
    );
  });

  it("never emits a raw JSON object — falls back to key=value or key names", () => {
    const out = formatToolArgs("mcp__x__do", { limit: 5, recursive: true });
    expect(out).not.toContain("{");
    expect(out).not.toContain('"');
    expect(out).toBe("limit=5, recursive=true");

    const keysOnly = formatToolArgs("weird", { a: {}, b: [] });
    expect(keysOnly).toBe("a, b");
  });

  it("caps long values so a tool line never becomes a wall of text", () => {
    const long = "x".repeat(200);
    const out = formatToolArgs("Bash", { command: long });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(81);
  });

  it("handles scalar / null input without throwing", () => {
    expect(formatToolArgs("thing", "hello")).toBe("hello");
    expect(formatToolArgs("thing", null)).toBe("");
  });
});

describe("formatToolCall", () => {
  it("composes emoji + tool name + pretty args", () => {
    expect(formatToolCall("Read", { file_path: "src/index.ts" })).toBe(
      `${getToolEmoji("Read")} read(src/index.ts)`,
    );
    expect(formatToolCall("Bash", { command: "ls -la" })).toBe(
      `${getToolEmoji("Bash")} bash(ls -la)`,
    );
  });

  it("renders dotted capability names with dashes and no raw JSON", () => {
    const line = formatToolCall("suggest_semantic_edges", { nodeId: "n1", limit: 3 });
    expect(line).toContain("semantic-edge-suggest(");
    expect(line).not.toContain("{");
  });
});

describe("toolDisplayLabel", () => {
  it("Title-cases single-word core tools", () => {
    expect(toolDisplayLabel("bash")).toBe("Bash");
    expect(toolDisplayLabel("Read")).toBe("Read");
    expect(toolDisplayLabel("edit")).toBe("Edit");
  });

  it("keeps dotted capability names verbatim (precise identifiers)", () => {
    expect(toolDisplayLabel("suggest_semantic_edges")).toBe("suggest_semantic_edges");
    expect(toolDisplayLabel("knowledge.query")).toBe("knowledge.query");
  });
});

describe("getToolAccent", () => {
  it("colors by what the tool does", () => {
    expect(getToolAccent("Write")).toBe("#34D399"); // green — mutation
    expect(getToolAccent("Edit")).toBe("#34D399");
    expect(getToolAccent("Delete")).toBe("#FB7185"); // red — destruction
    expect(getToolAccent("Bash")).toBe("#FBBF24"); // amber — command
    expect(getToolAccent("Read")).toBe("#7CE8F4"); // cyan — read
    expect(getToolAccent("dispatch_subagent")).toBe("#A78BFA"); // violet — delegation
  });
});

describe("isSubagentDispatch / subagentInfo", () => {
  it("detects delegation tools", () => {
    expect(isSubagentDispatch("dispatch_subagent")).toBe(true);
    expect(isSubagentDispatch("spawnAgent")).toBe(true);
    expect(isSubagentDispatch("Read")).toBe(false);
  });

  it("extracts slug + task across the field names the engine uses", () => {
    expect(subagentInfo({ agent: "break-fix", task: "fix the bug" })).toEqual({
      slug: "break-fix",
      task: "fix the bug",
    });
    expect(subagentInfo({ subagent: "judge", prompt: "review it" })).toEqual({
      slug: "judge",
      task: "review it",
    });
    expect(subagentInfo("nope")).toEqual({});
  });

  it("formats a dispatch call as `slug → task`", () => {
    expect(
      formatToolArgs("dispatch_subagent", { agent: "show-agent", task: "wire the indicator" }),
    ).toBe("show-agent → wire the indicator");
    // Slug-only and task-only inputs still degrade gracefully.
    expect(formatToolArgs("dispatch_subagent", { agent: "solo" })).toBe("solo");
    expect(formatToolArgs("dispatch_subagent", { task: "just do it" })).toBe("just do it");
  });
});
