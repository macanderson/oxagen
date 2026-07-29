/**
 * `oxagen agent` output-discipline tests (ADR-023 §4).
 *
 * pretty mode → the human view on stdout; `--json` → exactly one single-line
 * JSON value on stdout (list → summary array, show → the definition), shape
 * preserved; every failure is a uniform stderr line (pretty `✗ …`, json
 * `{"type":"error",…}`) with nothing on stdout — a bad name exits 2 (usage),
 * an unknown agent exits 1. A fake CommandWriter captures stdout/stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentList, agentShow, agentNew, type AgentCmdCtx } from "../agent.js";
import { clearSettingsCache } from "../../settings/resolve.js";
import type { CommandWriter } from "../../lib/capture-writer.js";

let dir: string;
let ctx: AgentCmdCtx;

function writeAgent(name: string, body: string): void {
  const p = join(dir, ".oxagen", "agents", `${name}.toml`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}

/** A fake CommandWriter that captures stdout/stderr lines into arrays (ADR-023 §4). */
function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (l) => void out.push(l),
      writeErr: (l) => void err.push(l),
    },
    out,
    err,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-agent-"));
  ctx = {
    cwd: dir,
    userAgentsDir: join(dir, "user-agents"),
    settingsOptions: { userSettingsPath: join(dir, "user-settings.json") },
  };
  process.exitCode = undefined;
  clearSettingsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  clearSettingsCache();
});

describe("agent command handlers — pretty mode", () => {
  it("lists nothing when there are no agents", () => {
    const { writer, out, err } = makeWriter();
    agentList(ctx, writer);
    expect(out.join("\n")).toContain("No agents defined");
    expect(err).toEqual([]);
  });

  it("lists agents with description, tools and model", () => {
    writeAgent(
      "reviewer",
      'schema_version = 1\nkind = "agent"\nname = "reviewer"\ndescription = "Reviews code"\nmodel = "a/b"\ndeveloper_instructions = "You review code."\ntools = ["read_file", "grep"]\n',
    );
    const { writer, out } = makeWriter();
    agentList(ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("reviewer");
    expect(text).toContain("Reviews code");
    expect(text).toContain("read_file, grep");
    expect(text).toContain("a/b");
  });

  it("shows an agent's full definition", () => {
    writeAgent(
      "reviewer",
      'schema_version = 1\nkind = "agent"\nname = "reviewer"\ndescription = "Reviews code"\ndeveloper_instructions = "You review code carefully."\n',
    );
    const { writer, out } = makeWriter();
    agentShow("reviewer", ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("# reviewer");
    expect(text).toContain("system prompt");
    expect(text).toContain("You review code carefully.");
  });

  it("errors to stderr (not stdout) with exit 1 for an unknown agent", () => {
    const { writer, out, err } = makeWriter();
    agentShow("ghost", ctx, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Unknown agent");
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a new agent and is idempotent", () => {
    const first = makeWriter();
    agentNew("builder", ctx, first.writer);
    expect(first.out.join("\n")).toContain("Created agent");
    expect(existsSync(join(dir, ".oxagen", "agents", "builder.toml"))).toBe(
      true,
    );
    const second = makeWriter();
    agentNew("builder", ctx, second.writer);
    expect(second.out.join("\n")).toContain("already exists");
  });

  it("rejects an invalid agent name with a usage error (exit 2)", () => {
    const { writer, out, err } = makeWriter();
    agentNew("bad name!", ctx, writer);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Invalid agent name");
    expect(process.exitCode).toBe(2);
  });

  it("a scaffolded agent is immediately listable", () => {
    agentNew("fresh", ctx, makeWriter().writer);
    const { writer, out } = makeWriter();
    agentList(ctx, writer);
    expect(out.join("\n")).toContain("fresh");
  });
});

describe("agent command handlers — --json mode", () => {
  it("list emits one single-line JSON array preserving the summary shape", () => {
    writeAgent(
      "reviewer",
      'schema_version = 1\nkind = "agent"\nname = "reviewer"\ndescription = "Reviews code"\nmodel = "a/b"\ndeveloper_instructions = "You review code."\ntools = ["read_file", "grep"]\n',
    );
    const { writer, out, err } = makeWriter();
    agentList({ ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      name: "reviewer",
      description: "Reviews code",
      source: expect.any(String),
      tools: ["read_file", "grep"],
      model: "a/b",
    });
    expect(err).toEqual([]);
  });

  it("list emits an empty JSON array (not prose) when there are no agents", () => {
    const { writer, out } = makeWriter();
    agentList({ ...ctx, json: true }, writer);
    expect(out).toEqual(["[]"]);
  });

  it("show emits one single-line JSON object round-tripping the definition", () => {
    writeAgent(
      "reviewer",
      'schema_version = 1\nkind = "agent"\nname = "reviewer"\ndescription = "Reviews code"\ndeveloper_instructions = "You review code carefully."\n',
    );
    const { writer, out } = makeWriter();
    agentShow("reviewer", { ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(parsed.name).toBe("reviewer");
    expect(String(parsed.systemPrompt)).toContain("You review code carefully.");
    expect(typeof parsed.source).toBe("string");
  });

  it("emits a single-line JSON error object on stderr for an unknown agent", () => {
    const { writer, out, err } = makeWriter();
    agentShow("ghost", { ...ctx, json: true }, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(JSON.parse(err[0] as string)).toEqual({
      type: "error",
      code: "not_found",
      message: expect.stringContaining("Unknown agent"),
    });
    expect(process.exitCode).toBe(1);
  });
});
