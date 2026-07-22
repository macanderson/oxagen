/**
 * buildTurnExtras — the shared assembly that feeds the engine's extraTools /
 * wrapTools seams. Covers: rules → systemAppend, MCP gating by config, the agent
 * allowlist filter, and rule-guard denies enforced through the tool gate.
 */
import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import { buildTurnExtras } from "../turn-extras.js";
import type { Rule } from "../../rules/types.js";
import type { OxagenSettings } from "../../settings/schema.js";

const migrationsRule: Rule = {
  id: "no-edit-migrations",
  description: "Protect migrations",
  text: "Never edit files under migrations/",
  guard: { tool: "Edit", denyPathGlob: "migrations/**" },
  source: "test",
};

/** A tool set mirroring the engine's names, with trivial executes. */
function fakeTools(): ToolSet {
  return {
    read_file: {
      description: "read",
      inputSchema: {},
      execute: async () => "contents",
    },
    edit_file: {
      description: "edit",
      inputSchema: {},
      execute: async () => "edited",
    },
  } as unknown as ToolSet;
}

const emptySettings = { mcpServers: {} } as unknown as OxagenSettings;

describe("buildTurnExtras", () => {
  it("renders guarded rules into systemAppend", async () => {
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings: emptySettings,
      rules: [migrationsRule],
    });
    expect(extras.systemAppend).toContain("Never edit files under migrations/");
    expect(extras.systemAppend).toContain("[enforced]");
  });

  it("adds no MCP tools when no servers are configured", async () => {
    // skills injected empty: the DEFAULT loader also reads user-level dirs
    // (~/.claude/skills), which would make this hermetic assertion
    // machine-dependent.
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings: emptySettings,
      rules: [],
      skills: [],
    });
    expect(extras.extraTools).toBeUndefined();
    // Empty rules + no skills ⇒ empty systemAppend.
    expect(extras.systemAppend).toBe("");
  });

  it("wrapTools restricts to the agent allowlist", async () => {
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings: emptySettings,
      rules: [],
      agentTools: ["read_file"],
    });
    const wrapped = extras.wrapTools(fakeTools());
    expect(Object.keys(wrapped).sort()).toEqual(["read_file"]);
  });

  it("wrapTools hard-blocks a tool the rule guard denies (returns a deny result)", async () => {
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings: emptySettings,
      rules: [migrationsRule],
    });
    const wrapped = extras.wrapTools(fakeTools());
    // edit_file is present (not filtered) but its execute is now gated.
    const editExec = (
      wrapped["edit_file"] as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute;
    const denied = await editExec(
      { path: "migrations/0001_init.sql", old_string: "a", new_string: "b" },
      {},
    );
    expect(String(denied)).toMatch(/den|not allowed|blocked|migrations/i);
    // A non-migrations edit is allowed through to the real execute.
    const ok = await editExec(
      { path: "src/app.ts", old_string: "a", new_string: "b" },
      {},
    );
    expect(ok).toBe("edited");
  });

  it("does not gate settings.permissions when gatePermissions is false (broker owns them)", async () => {
    const settings = {
      mcpServers: {},
      permissions: { deny: ["Bash(*)"] },
    } as unknown as OxagenSettings;
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings,
      rules: [],
      gatePermissions: false,
    });
    const tools = {
      bash: { description: "b", inputSchema: {}, execute: async () => "ran" },
    } as unknown as ToolSet;
    const wrapped = extras.wrapTools(tools);
    const bashExec = (
      wrapped["bash"] as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute;
    // Broker (not this gate) owns settings.permissions, so bash is NOT blocked here.
    expect(await bashExec({ command: "ls" }, {})).toBe("ran");
  });

  it("DOES gate settings.permissions when gatePermissions is true (no broker path)", async () => {
    const settings = {
      mcpServers: {},
      permissions: { deny: ["Bash(*)"] },
    } as unknown as OxagenSettings;
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings,
      rules: [],
      gatePermissions: true,
    });
    const tools = {
      bash: { description: "b", inputSchema: {}, execute: async () => "ran" },
    } as unknown as ToolSet;
    const wrapped = extras.wrapTools(tools);
    const bashExec = (
      wrapped["bash"] as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute;
    const out = await bashExec({ command: "ls" }, {});
    expect(String(out)).toMatch(/den|not allowed|blocked/i);
  });
});

describe("buildTurnExtras — skills injection", () => {
  const skills = [
    {
      name: "deploy",
      description: "Deploy the app safely",
      body: "## Steps\nRun deploy.sh with the staging flag first.",
      path: "/x/deploy/skill.toml",
      source: "test",
    },
    {
      name: "review",
      description: "Review code for defects",
      body: "The full review protocol lives here.",
      path: "/x/review/skill.toml",
      source: "test",
    },
  ];

  it("lists every discovered skill compactly without a selection (no bodies)", async () => {
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings: emptySettings,
      rules: [],
      skills,
    });
    expect(extras.systemAppend).toContain("deploy");
    expect(extras.systemAppend).toContain("Deploy the app safely");
    expect(extras.systemAppend).toContain("Review code for defects");
    // Progressive disclosure: bodies stay OUT of the prompt until selected.
    expect(extras.systemAppend).not.toContain("Run deploy.sh");
    expect(extras.systemAppend).not.toContain("full review protocol");
  });

  it("injects FULL bodies only for the agent's declared skills", async () => {
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings: emptySettings,
      rules: [],
      skills,
      agentSkills: ["deploy"],
    });
    expect(extras.systemAppend).toContain(
      "Run deploy.sh with the staging flag",
    );
    expect(extras.systemAppend).not.toContain("full review protocol");
  });
});

describe("buildTurnExtras — per-agent MCP-server selection", () => {
  it("an empty agentMcpServers list connects to NOTHING even when servers are configured", async () => {
    const settings = {
      mcpServers: {
        github: { command: "definitely-not-a-real-binary", args: [] },
      },
    } as unknown as OxagenSettings;
    // [] narrows the configured map to zero servers, so loadMcpTools is never
    // invoked at all — no connection attempt, no extraTools.
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings,
      rules: [],
      skills: [],
      agentMcpServers: [],
    });
    expect(extras.extraTools).toBeUndefined();
  });

  it("read-only mode still withholds MCP regardless of selection", async () => {
    const settings = {
      mcpServers: {
        github: { command: "definitely-not-a-real-binary", args: [] },
      },
    } as unknown as OxagenSettings;
    const extras = await buildTurnExtras({
      cwd: "/tmp/x",
      settings,
      rules: [],
      skills: [],
      readOnly: true,
      agentMcpServers: ["github"],
    });
    expect(extras.extraTools).toBeUndefined();
  });
});
