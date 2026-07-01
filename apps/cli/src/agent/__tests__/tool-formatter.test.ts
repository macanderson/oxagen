/**
 * Tool formatter — proves the CLI renders tool calls as pretty, human-readable
 * one-liners (`edit(a.ts)`, `bash(git push)`) and NEVER dumps the raw JSON
 * argument object at the user.
 */
import { describe, it, expect } from "vitest";
import { formatToolArgs, formatToolCall, getToolEmoji } from "../tool-formatter.js";

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
    const line = formatToolCall("semantic.edge.suggest", { nodeId: "n1", limit: 3 });
    expect(line).toContain("semantic-edge-suggest(");
    expect(line).not.toContain("{");
  });
});
