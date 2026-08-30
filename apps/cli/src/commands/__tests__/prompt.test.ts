/**
 * `oxagen prompt` output-discipline tests (ADR-023 §4).
 *
 * pretty mode → the human view on stdout; `--json` → exactly one single-line
 * JSON value on stdout (list → summary array, show → the prompt), shape
 * preserved; every failure is a uniform stderr line (pretty `✗ …`, json
 * `{"type":"error",…}`) with nothing on stdout — a bad name exits 2 (usage),
 * an unknown prompt exits 1. A fake CommandWriter captures stdout/stderr.
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
import {
  promptList,
  promptShow,
  promptNew,
  type PromptCmdCtx,
} from "../prompt.js";
import type { CommandWriter } from "../../lib/capture-writer.js";

let dir: string;
let ctx: PromptCmdCtx;

function writePrompt(name: string, body: string): void {
  const p = join(dir, ".oxagen", "prompts", `${name}.md`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}

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
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-prompt-"));
  ctx = { cwd: dir, userPromptsDir: join(dir, "user-prompts") };
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("prompt handlers — pretty mode", () => {
  it("lists nothing when empty", () => {
    const { writer, out, err } = makeWriter();
    promptList(ctx, writer);
    expect(out.join("\n")).toContain("No saved prompts");
    expect(err).toEqual([]);
  });

  it("lists prompts with hint and description", () => {
    writePrompt(
      "triage",
      "---\ndescription: Triage a bug\nargument-hint: <ticket>\n---\nTriage it.",
    );
    const { writer, out } = makeWriter();
    promptList(ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("triage <ticket>");
    expect(text).toContain("Triage a bug");
  });

  it("shows a prompt's body", () => {
    writePrompt(
      "triage",
      "---\ndescription: Triage a bug\n---\nTriage the ticket carefully.",
    );
    const { writer, out } = makeWriter();
    promptShow("triage", ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("# triage");
    expect(text).toContain("prompt");
    expect(text).toContain("Triage the ticket carefully.");
  });

  it("errors to stderr (not stdout) with exit 1 for an unknown prompt", () => {
    const { writer, out, err } = makeWriter();
    promptShow("ghost", ctx, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Unknown prompt");
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a new prompt and is idempotent", () => {
    const first = makeWriter();
    promptNew("standup", ctx, first.writer);
    expect(first.out.join("\n")).toContain("Created prompt");
    expect(existsSync(join(dir, ".oxagen", "prompts", "standup.md"))).toBe(
      true,
    );
    const second = makeWriter();
    promptNew("standup", ctx, second.writer);
    expect(second.out.join("\n")).toContain("already exists");
  });

  it("rejects an invalid prompt name with a usage error (exit 2)", () => {
    const { writer, out, err } = makeWriter();
    promptNew("bad name", ctx, writer);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Invalid prompt name");
    expect(process.exitCode).toBe(2);
  });

  it("a scaffolded prompt is immediately listable", () => {
    promptNew("fresh", ctx, makeWriter().writer);
    const { writer, out } = makeWriter();
    promptList(ctx, writer);
    expect(out.join("\n")).toContain("fresh");
  });
});

describe("prompt handlers — --json mode", () => {
  it("list emits one single-line JSON array preserving the summary shape", () => {
    writePrompt(
      "triage",
      "---\ndescription: Triage a bug\nargument-hint: <ticket>\n---\nTriage it.",
    );
    const { writer, out, err } = makeWriter();
    promptList({ ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      name: "triage",
      description: "Triage a bug",
      argumentHint: "<ticket>",
      source: expect.any(String),
    });
    expect(err).toEqual([]);
  });

  it("list emits an empty JSON array (not prose) when empty", () => {
    const { writer, out } = makeWriter();
    promptList({ ...ctx, json: true }, writer);
    expect(out).toEqual(["[]"]);
  });

  it("show emits one single-line JSON object round-tripping the body", () => {
    writePrompt(
      "triage",
      "---\ndescription: Triage a bug\n---\nTriage the ticket carefully.",
    );
    const { writer, out } = makeWriter();
    promptShow("triage", { ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(parsed.name).toBe("triage");
    expect(String(parsed.body)).toContain("Triage the ticket carefully.");
    expect(typeof parsed.source).toBe("string");
  });

  it("emits a single-line JSON error object on stderr for an unknown prompt", () => {
    const { writer, out, err } = makeWriter();
    promptShow("ghost", { ...ctx, json: true }, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(JSON.parse(err[0] as string)).toEqual({
      type: "error",
      code: "not_found",
      message: expect.stringContaining("Unknown prompt"),
    });
    expect(process.exitCode).toBe(1);
  });
});
