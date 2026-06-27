import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentList, agentShow, agentNew, type AgentCmdCtx } from "../agent.js";
import { clearSettingsCache } from "../../settings/resolve.js";

let dir: string;
let ctx: AgentCmdCtx;
let out: string[];
let err: string[];

function writeAgent(name: string, body: string): void {
  const p = join(dir, ".oxagen", "agents", `${name}.md`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-agent-"));
  ctx = {
    cwd: dir,
    userAgentsDir: join(dir, "user-agents"),
    settingsOptions: { userSettingsPath: join(dir, "user-settings.json") },
  };
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  process.exitCode = undefined;
  clearSettingsCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  clearSettingsCache();
});

const text = () => out.join("\n");

describe("agent command handlers", () => {
  it("lists nothing when there are no agents", () => {
    agentList(ctx);
    expect(text()).toContain("No agents defined");
  });

  it("lists agents with description, tools and model", () => {
    writeAgent("reviewer", "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: a/b\n---\nYou review code.");
    agentList(ctx);
    expect(text()).toContain("reviewer");
    expect(text()).toContain("Reviews code");
    expect(text()).toContain("Read, Grep");
    expect(text()).toContain("a/b");
  });

  it("shows an agent's full definition", () => {
    writeAgent("reviewer", "---\nname: reviewer\ndescription: Reviews code\n---\nYou review code carefully.");
    agentShow("reviewer", ctx);
    expect(text()).toContain("# reviewer");
    expect(text()).toContain("system prompt");
    expect(text()).toContain("You review code carefully.");
  });

  it("errors when showing an unknown agent", () => {
    agentShow("ghost", ctx);
    expect(err.join("\n")).toContain("Unknown agent");
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a new agent and is idempotent", () => {
    agentNew("builder", ctx);
    expect(text()).toContain("Created agent");
    expect(existsSync(join(dir, ".oxagen", "agents", "builder.md"))).toBe(true);
    out = [];
    agentNew("builder", ctx);
    expect(text()).toContain("already exists");
  });

  it("rejects an invalid agent name", () => {
    agentNew("bad name!", ctx);
    expect(err.join("\n")).toContain("Invalid agent name");
    expect(process.exitCode).toBe(1);
  });

  it("a scaffolded agent is immediately listable", () => {
    agentNew("fresh", ctx);
    out = [];
    agentList(ctx);
    expect(text()).toContain("fresh");
  });
});
