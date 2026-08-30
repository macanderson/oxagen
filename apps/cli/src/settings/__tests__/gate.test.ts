import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapToolsWithGate } from "../gate.js";
import type { Hooks, Permissions } from "../schema.js";

const CWD = process.cwd();

/** Build a tool set that records each execution into `calls`. */
function makeTools(calls: string[]): ToolSet {
  return {
    bash: tool({
      description: "run a command",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        calls.push(`bash:${command}`);
        return `ran: ${command}`;
      },
    }),
    write_file: tool({
      description: "write a file",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path }) => {
        calls.push(`write:${path}`);
        return `wrote ${path}`;
      },
    }),
  };
}

type Exec = NonNullable<ToolSet[string]["execute"]>;
const CALL_OPTS = {
  toolCallId: "test",
  messages: [],
} as unknown as Parameters<Exec>[1];

async function call(
  tools: ToolSet,
  name: string,
  input: unknown,
): Promise<unknown> {
  const exec = tools[name]?.execute;
  if (!exec) throw new Error(`no execute for ${name}`);
  return exec(input as never, CALL_OPTS);
}

describe("wrapToolsWithGate", () => {
  it("returns the same tool set when nothing is configured", () => {
    const tools = makeTools([]);
    expect(wrapToolsWithGate(tools, { cwd: CWD })).toBe(tools);
  });

  it("blocks a denied tool and never calls the original execute", async () => {
    const calls: string[] = [];
    const blocked: string[] = [];
    const permissions: Permissions = { deny: ["Bash(rm -rf*)"] };
    const gated = wrapToolsWithGate(makeTools(calls), {
      cwd: CWD,
      permissions,
      onBlocked: (name) => blocked.push(name),
    });
    const result = await call(gated, "bash", { command: "rm -rf /tmp/x" });
    expect(String(result)).toContain("⛔");
    expect(String(result)).toContain("Permission denied");
    expect(calls).toEqual([]); // original never ran
    expect(blocked).toEqual(["bash"]);
  });

  it("gates MCP tools by their mcp__server__tool name", async () => {
    const calls: string[] = [];
    const mcpTools: ToolSet = {
      mcp__github__delete_repo: tool({
        description: "delete",
        inputSchema: z.object({ repo: z.string() }),
        execute: async () => {
          calls.push("deleted");
          return "deleted";
        },
      }),
    };
    const gated = wrapToolsWithGate(mcpTools, {
      cwd: CWD,
      permissions: { deny: ["mcp__github__delete_*"] },
    });
    const result = await call(gated, "mcp__github__delete_repo", { repo: "x" });
    expect(String(result)).toContain("⛔");
    expect(calls).toEqual([]);
  });

  it("passes an allowed tool through to the original execute", async () => {
    const calls: string[] = [];
    const permissions: Permissions = { deny: ["Bash(rm -rf*)"] };
    const gated = wrapToolsWithGate(makeTools(calls), {
      cwd: CWD,
      permissions,
    });
    const result = await call(gated, "bash", { command: "git status" });
    expect(result).toBe("ran: git status");
    expect(calls).toEqual(["bash:git status"]);
  });

  it("surfaces the rule text (denyReasons) instead of the raw glob when a guard blocks", async () => {
    const calls: string[] = [];
    const blocked: string[] = [];
    const gated = wrapToolsWithGate(makeTools(calls), {
      cwd: CWD,
      permissions: { deny: ["Bash(rm -rf*)"] },
      denyReasons: {
        "Bash(rm -rf*)":
          'rule "no-rm-rf" — Never run destructive recursive deletes.',
      },
      onBlocked: (_n, reason) => blocked.push(reason),
    });
    const result = await call(gated, "bash", { command: "rm -rf /tmp/x" });
    expect(String(result)).toContain(
      "Never run destructive recursive deletes.",
    );
    expect(String(result)).toContain('rule "no-rm-rf"');
    expect(calls).toEqual([]);
    expect(blocked[0]).toContain("no-rm-rf");
  });

  it("blocks a tool when a PreToolUse hook vetoes it", async () => {
    const calls: string[] = [];
    const blocked: string[] = [];
    const hooks: Hooks = {
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [
            { type: "command", command: 'echo "denied by policy" >&2; exit 1' },
          ],
        },
      ],
    };
    const gated = wrapToolsWithGate(makeTools(calls), {
      cwd: CWD,
      hooks,
      onBlocked: (name, reason) => blocked.push(`${name}:${reason}`),
    });
    const result = await call(gated, "bash", { command: "ls" });
    expect(String(result)).toContain("Blocked by PreToolUse hook");
    expect(String(result)).toContain("denied by policy");
    expect(calls).toEqual([]);
    expect(blocked[0]).toContain("bash:");
  });

  describe("PostToolUse side effects", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "oxagen-gate-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("runs PostToolUse after a successful execute without blocking", async () => {
      const calls: string[] = [];
      const marker = join(dir, "post.ran");
      const hooks: Hooks = {
        PostToolUse: [
          {
            matcher: "write_file",
            hooks: [{ type: "command", command: `touch '${marker}'` }],
          },
        ],
      };
      const gated = wrapToolsWithGate(makeTools(calls), { cwd: CWD, hooks });
      const result = await call(gated, "write_file", {
        path: "a.txt",
        content: "x",
      });
      expect(result).toBe("wrote a.txt");
      expect(calls).toEqual(["write:a.txt"]);
      expect(existsSync(marker)).toBe(true);
    });
  });
});
