/**
 * `oxagen skill` output-discipline tests (ADR-023 §4).
 *
 * pretty mode → the human view on stdout; `--json` → exactly one single-line
 * JSON value on stdout (list → summary array, show → the skill), shape
 * preserved; every failure is a uniform stderr line (pretty `✗ …`, json
 * `{"type":"error",…}`) with nothing on stdout — a bad name exits 2 (usage),
 * an unknown skill exits 1. A fake CommandWriter captures stdout/stderr.
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
import { serializeArtifactToml } from "@oxagen/agent-artifacts";
import { skillList, skillShow, skillNew, type SkillCmdCtx } from "../skill.js";
import type { CommandWriter } from "../../lib/capture-writer.js";

let dir: string;
let home: string;
let ctx: SkillCmdCtx;

function writeSkill(name: string, body: string): void {
  const p = join(dir, ".oxagen", "skills", name, "skill.toml");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(
    p,
    serializeArtifactToml({
      schema_version: 1,
      kind: "skill",
      name,
      description: "Reviews diffs",
      instructions: body,
      references: [],
    }),
    "utf8",
  );
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
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-skill-"));
  home = mkdtempSync(join(tmpdir(), "oxagen-cmd-skill-home-"));
  ctx = { cwd: dir, userHomeDir: home };
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("skill handlers — pretty mode", () => {
  it("lists nothing when empty", () => {
    const { writer, out, err } = makeWriter();
    skillList(ctx, writer);
    expect(out.join("\n")).toContain("No skills defined");
    expect(err).toEqual([]);
  });

  it("lists skills with description and path", () => {
    writeSkill("reviewer", "How to review.");
    const { writer, out } = makeWriter();
    skillList(ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("reviewer");
    expect(text).toContain("Reviews diffs");
  });

  it("shows a skill's instructions", () => {
    writeSkill("reviewer", "How to review a diff carefully.");
    const { writer, out } = makeWriter();
    skillShow("reviewer", ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("# reviewer");
    expect(text).toContain("instructions");
    expect(text).toContain("How to review a diff carefully.");
  });

  it("errors to stderr (not stdout) with exit 1 for an unknown skill", () => {
    const { writer, out, err } = makeWriter();
    skillShow("ghost", ctx, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Unknown skill");
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a new skill dir and is idempotent", () => {
    const first = makeWriter();
    skillNew("deploy", ctx, first.writer);
    expect(first.out.join("\n")).toContain("Created skill");
    expect(
      existsSync(join(dir, ".oxagen", "skills", "deploy", "skill.toml")),
    ).toBe(true);
    const second = makeWriter();
    skillNew("deploy", ctx, second.writer);
    expect(second.out.join("\n")).toContain("already exists");
  });

  it("rejects an invalid skill name with a usage error (exit 2)", () => {
    const { writer, out, err } = makeWriter();
    skillNew("bad name", ctx, writer);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Invalid skill name");
    expect(process.exitCode).toBe(2);
  });

  it("a scaffolded skill is immediately listable", () => {
    skillNew("fresh", ctx, makeWriter().writer);
    const { writer, out } = makeWriter();
    skillList(ctx, writer);
    expect(out.join("\n")).toContain("fresh");
  });
});

describe("skill handlers — --json mode", () => {
  it("list emits one single-line JSON array preserving the summary shape", () => {
    writeSkill("reviewer", "How to review.");
    const { writer, out, err } = makeWriter();
    skillList({ ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "reviewer",
      description: "Reviews diffs",
      path: expect.any(String),
      source: expect.any(String),
    });
    expect(err).toEqual([]);
  });

  it("list emits an empty JSON array (not prose) when empty", () => {
    const { writer, out } = makeWriter();
    skillList({ ...ctx, json: true }, writer);
    expect(out).toEqual(["[]"]);
  });

  it("show emits one single-line JSON object round-tripping the body", () => {
    writeSkill("reviewer", "How to review a diff carefully.");
    const { writer, out } = makeWriter();
    skillShow("reviewer", { ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(parsed.name).toBe("reviewer");
    expect(String(parsed.body)).toContain("How to review a diff carefully.");
  });

  it("emits a single-line JSON error object on stderr for an unknown skill", () => {
    const { writer, out, err } = makeWriter();
    skillShow("ghost", { ...ctx, json: true }, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(JSON.parse(err[0] as string)).toEqual({
      type: "error",
      code: "not_found",
      message: expect.stringContaining("Unknown skill"),
    });
    expect(process.exitCode).toBe(1);
  });
});
