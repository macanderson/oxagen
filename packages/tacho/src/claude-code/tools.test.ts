import { describe, expect, it } from "vitest";
import {
  classifyShellEffect,
  classifyTool,
  commandHead,
  gitSubcommand,
  tokenizeSimpleCommand,
} from "./tools";

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

describe("git effect classification", () => {
  it("classifies a push, a commit, and a pull request opened from the shell", () => {
    expect(classifyTool("Bash", { command: "git push" })).toMatchObject({
      effect_kind: "git_push",
      tool_is_mutating: true,
      tool_target: "git push",
    });
    expect(
      classifyTool("Bash", {
        command: "git push --force-with-lease origin HEAD:main",
      }),
    ).toMatchObject({ effect_kind: "git_push" });
    expect(
      classifyTool("Bash", { command: "git -C /repo push origin main" }),
    ).toMatchObject({ effect_kind: "git_push" });
    expect(
      classifyTool("Bash", {
        command: 'git commit -m "fix: classify the push; keep the head"',
      }),
    ).toMatchObject({ effect_kind: "git_commit" });
    expect(
      classifyTool("Bash", {
        command: "git -c commit.gpgsign=false commit --amend --no-edit",
      }),
    ).toMatchObject({ effect_kind: "git_commit" });
    expect(
      classifyTool("Bash", { command: "gh pr create --draft --fill" }),
    ).toMatchObject({ effect_kind: "pr_open" });
  });

  it("falls back to a generic command wherever the shape is not certain", () => {
    for (const command of [
      "git status",
      "git log --oneline -5",
      "echo git push",
      'echo "git push origin main"',
      "git push | tee push.log",
      "git push --dry-run",
      "git push -n origin main",
      "git commit --dry-run",
      // `gh pr create --dry-run` prints what it would do and creates
      // nothing, so counting it would put a pull request on the run's
      // record that does not exist.
      "gh pr create --dry-run",
      "gh pr create --dry-run --fill",
      "git --unknown-option push",
      "git $(cat sub) push",
      "gh pr list",
      "gh pr view 12",
      "ls",
      "pnpm --filter @oxagen/tacho test:unit",
    ]) {
      expect(classifyTool("Bash", { command })).toMatchObject({
        effect_kind: "command",
      });
    }
    expect(classifyTool("Bash", {})).toMatchObject({ effect_kind: "command" });
  });

  it("classifies the MCP pull request tool by its tool name, not its server", () => {
    expect(classifyTool("mcp__github__create_pull_request", {})).toMatchObject({
      effect_kind: "pr_open",
      mcp_tool_name: "create_pull_request",
      tool_is_mutating: true,
    });
    expect(classifyTool("mcp__forge__create_pull_request", {})).toMatchObject({
      effect_kind: "pr_open",
      mcp_server_name: "forge",
    });
    expect(classifyTool("mcp__github__update_pull_request", {})).toMatchObject({
      effect_kind: "network",
    });
  });

  it("tokenizes one simple command and refuses everything else", () => {
    expect(tokenizeSimpleCommand("git  push   origin")).toEqual([
      "git",
      "push",
      "origin",
    ]);
    expect(tokenizeSimpleCommand('git commit -m "a b"')).toEqual([
      "git",
      "commit",
      "-m",
      "a b",
    ]);
    expect(tokenizeSimpleCommand("git commit -m ''")).toEqual([
      "git",
      "commit",
      "-m",
      "",
    ]);
    expect(tokenizeSimpleCommand("a | b")).toBeUndefined();
    expect(tokenizeSimpleCommand("a; b")).toBeUndefined();
    expect(tokenizeSimpleCommand("a `b`")).toBeUndefined();
    expect(tokenizeSimpleCommand('git commit -m "unclosed')).toBeUndefined();
    expect(tokenizeSimpleCommand("   ")).toEqual([]);
  });

  it("reads past the git global options to the subcommand", () => {
    expect(gitSubcommand(["git", "-C", "/repo", "push"])).toEqual({
      name: "push",
      index: 3,
    });
    expect(gitSubcommand(["git", "--no-pager", "log"])).toEqual({
      name: "log",
      index: 2,
    });
    expect(gitSubcommand(["git", "--git-dir=/x/.git", "commit"])).toEqual({
      name: "commit",
      index: 2,
    });
    expect(gitSubcommand(["git", "--made-up", "push"])).toBeUndefined();
    expect(gitSubcommand(["git"])).toBeUndefined();
  });

  it("answers undefined for a line that names no git effect", () => {
    expect(classifyShellEffect("")).toBeUndefined();
    expect(classifyShellEffect("git")).toBeUndefined();
  });
});

/**
 * Cursor's tool vocabulary (verified 2026-09-18 against
 * https://cursor.com/docs/agent/hooks, fetched that day): `Shell`, `Read`,
 * `Write`, `Grep`, `Delete`, `Task`, and `MCP:<tool_name>`. The adapter does
 * not rewrite these, because a record that renamed the tool would no longer
 * say what the harness reported, so the classification has to read them.
 */
describe("Cursor's tool names classify", () => {
  it("reads Shell the way it reads Bash, down to the git effect", () => {
    expect(classifyTool("Shell", { command: "git push origin main" })).toEqual({
      tool_source: "builtin",
      effect_kind: "git_push",
      tool_is_mutating: true,
      tool_target: "git push origin main",
    });
    expect(
      classifyTool("Shell", { command: 'git commit -m "fix: a; b"' })
        .effect_kind,
    ).toBe("git_commit");
    expect(classifyTool("Shell", { command: "ls -la" }).effect_kind).toBe(
      "command",
    );
  });

  it("classifies MCP:<tool> without inventing a server name", () => {
    // Cursor names no server, so the record carries the tool alone rather
    // than a server no harness reported.
    expect(classifyTool("MCP:create_pull_request", {})).toEqual({
      tool_source: "mcp",
      mcp_tool_name: "create_pull_request",
      effect_kind: "pr_open",
      tool_is_mutating: true,
    });
    expect(classifyTool("MCP:list_issues", {}).tool_is_mutating).toBe(false);
    // Claude Code's fully qualified form still carries its server.
    expect(classifyTool("mcp__github__list_issues", {}).mcp_server_name).toBe(
      "github",
    );
  });

  it("names Delete as a delete, which Claude Code has no tool for", () => {
    expect(classifyTool("Delete", { file_path: "/repo/gone.ts" })).toEqual({
      tool_source: "builtin",
      effect_kind: "file_delete",
      tool_is_mutating: true,
      tool_target: "/repo/gone.ts",
    });
  });

  it("shares the rest of the vocabulary with Claude Code", () => {
    expect(classifyTool("Read", { file_path: "/a.ts" }).effect_kind).toBe(
      "file_read",
    );
    expect(classifyTool("Grep", { pattern: "todo" }).effect_kind).toBe(
      "file_read",
    );
    // Cursor's Write covers both of Claude Code's Write and Edit.
    expect(classifyTool("Write", { file_path: "/a.ts" }).effect_kind).toBe(
      "file_write",
    );
    expect(classifyTool("Task", { description: "review" }).effect_kind).toBe(
      "subagent",
    );
  });
});
