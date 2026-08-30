import { describe, it, expect } from "vitest";
import { runHooks } from "../hooks.js";
import type { Hooks } from "../schema.js";

const CWD = process.cwd();

describe("runHooks", () => {
  it("returns a no-op outcome when there are no hooks", async () => {
    expect(
      await runHooks(undefined, { event: "SessionStart", cwd: CWD }),
    ).toEqual({
      blocked: false,
      output: "",
    });
  });

  it("captures SessionStart stdout as context", async () => {
    const hooks: Hooks = {
      SessionStart: [
        { hooks: [{ type: "command", command: "echo 'on-call: alice'" }] },
      ],
    };
    const out = await runHooks(hooks, { event: "SessionStart", cwd: CWD });
    expect(out.blocked).toBe(false);
    expect(out.output).toContain("on-call: alice");
  });

  it("feeds the event payload to the hook on stdin", async () => {
    const hooks: Hooks = {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "cat" }] },
      ],
    };
    const out = await runHooks(hooks, {
      event: "PreToolUse",
      cwd: CWD,
      tool: { name: "bash", input: { command: "ls" } },
    });
    expect(out.output).toContain('"name":"bash"');
    expect(out.output).toContain('"command":"ls"');
  });

  it("blocks a PreToolUse tool when a hook exits non-zero, surfacing stderr", async () => {
    const hooks: Hooks = {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [
            { type: "command", command: 'echo "no shell here" >&2; exit 1' },
          ],
        },
      ],
    };
    const out = await runHooks(hooks, {
      event: "PreToolUse",
      cwd: CWD,
      tool: { name: "bash", input: { command: "ls" } },
    });
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain("no shell here");
  });

  it("does not block when the PreToolUse hook exits zero", async () => {
    const hooks: Hooks = {
      PreToolUse: [
        { matcher: "bash", hooks: [{ type: "command", command: "true" }] },
      ],
    };
    const out = await runHooks(hooks, {
      event: "PreToolUse",
      cwd: CWD,
      tool: { name: "bash", input: {} },
    });
    expect(out.blocked).toBe(false);
  });

  it("only runs hooks whose matcher globs the tool name", async () => {
    const hooks: Hooks = {
      PreToolUse: [
        {
          matcher: "write_file",
          hooks: [{ type: "command", command: "exit 1" }],
        },
      ],
    };
    // tool is bash → matcher write_file does not apply → not blocked
    const bash = await runHooks(hooks, {
      event: "PreToolUse",
      cwd: CWD,
      tool: { name: "bash", input: {} },
    });
    expect(bash.blocked).toBe(false);
    // tool is write_file → matcher applies → blocked
    const write = await runHooks(hooks, {
      event: "PreToolUse",
      cwd: CWD,
      tool: { name: "write_file", input: {} },
    });
    expect(write.blocked).toBe(true);
  });

  it("never blocks on PostToolUse, even on a non-zero exit", async () => {
    const hooks: Hooks = {
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "echo done; exit 3" }],
        },
      ],
    };
    const out = await runHooks(hooks, {
      event: "PostToolUse",
      cwd: CWD,
      tool: { name: "write_file", input: {} },
    });
    expect(out.blocked).toBe(false);
    expect(out.output).toContain("done");
  });

  it("kills and blocks a PreToolUse hook that exceeds its timeout", async () => {
    const hooks: Hooks = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "sleep 5", timeoutMs: 50 }],
        },
      ],
    };
    const out = await runHooks(hooks, {
      event: "PreToolUse",
      cwd: CWD,
      tool: { name: "bash", input: {} },
    });
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain("timed out");
  });

  it("returns a no-op when the event has no registered matchers", async () => {
    const hooks: Hooks = {
      SessionStart: [{ hooks: [{ type: "command", command: "echo x" }] }],
    };
    expect(
      await runHooks(hooks, {
        event: "PreToolUse",
        cwd: CWD,
        tool: { name: "bash", input: {} },
      }),
    ).toEqual({ blocked: false, output: "" });
  });
});
