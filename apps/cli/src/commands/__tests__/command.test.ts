/**
 * `oxagen command` output-discipline tests (ADR-023 §4).
 *
 * pretty mode → the human view on stdout; `--json` → exactly one single-line
 * JSON value on stdout (list → summary array, show → the command), shape
 * preserved; every failure is a uniform stderr line (pretty `✗ …`, json
 * `{"type":"error",…}`) with nothing on stdout — a bad name exits 2 (usage),
 * an unknown command exits 1. A fake CommandWriter captures stdout/stderr.
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
  commandList,
  commandShow,
  commandNew,
  commandRun,
  type CommandCmdCtx,
} from "../command.js";
import type { CommandWriter } from "../../lib/capture-writer.js";

let dir: string;
let ctx: CommandCmdCtx;

function writeCmd(name: string, body: string): void {
  const p = join(dir, ".oxagen", "commands", `${name}.toml`);
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
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-command-"));
  ctx = { cwd: dir, userCommandsDir: join(dir, "user-commands") };
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("command handlers — pretty mode", () => {
  it("lists nothing when empty", () => {
    const { writer, out, err } = makeWriter();
    commandList(ctx, writer);
    expect(out.join("\n")).toContain("No slash commands");
    expect(err).toEqual([]);
  });

  it("lists commands with hint and description", () => {
    writeCmd(
      "review",
      'schema_version = 1\nkind = "command"\nname = "review"\ndescription = "Review code"\nargument_hint = "<file>"\nprompt = "Review $ARGUMENTS."\n',
    );
    const { writer, out } = makeWriter();
    commandList(ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("/review <file>");
    expect(text).toContain("Review code");
  });

  it("shows a command's template", () => {
    writeCmd(
      "review",
      'schema_version = 1\nkind = "command"\nname = "review"\ndescription = "Review code"\nprompt = "Review $ARGUMENTS carefully."\n',
    );
    const { writer, out } = makeWriter();
    commandShow("review", ctx, writer);
    const text = out.join("\n");
    expect(text).toContain("# /review");
    expect(text).toContain("template");
    expect(text).toContain("Review $ARGUMENTS carefully.");
  });

  it("errors to stderr (not stdout) with exit 1 for an unknown command", () => {
    const { writer, out, err } = makeWriter();
    commandShow("ghost", ctx, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Unknown command");
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a new command and is idempotent", () => {
    const first = makeWriter();
    commandNew("deploy", ctx, first.writer);
    expect(first.out.join("\n")).toContain("Created command");
    expect(existsSync(join(dir, ".oxagen", "commands", "deploy.toml"))).toBe(
      true,
    );
    const second = makeWriter();
    commandNew("deploy", ctx, second.writer);
    expect(second.out.join("\n")).toContain("already exists");
  });

  it("rejects an invalid command name with a usage error (exit 2)", () => {
    const { writer, out, err } = makeWriter();
    commandNew("bad name", ctx, writer);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Invalid command name");
    expect(process.exitCode).toBe(2);
  });

  it("a scaffolded command is immediately listable and showable", () => {
    commandNew("fresh", ctx, makeWriter().writer);
    const { writer, out } = makeWriter();
    commandList(ctx, writer);
    expect(out.join("\n")).toContain("/fresh");
  });

  it("errors to stderr with exit 1 when running an unknown command", async () => {
    const { writer, out, err } = makeWriter();
    await commandRun("ghost", [], ctx, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Unknown command");
    expect(process.exitCode).toBe(1);
  });
});

describe("command handlers — --json mode", () => {
  it("list emits one single-line JSON array preserving the summary shape", () => {
    writeCmd(
      "review",
      'schema_version = 1\nkind = "command"\nname = "review"\ndescription = "Review code"\nargument_hint = "<file>"\nmodel = "a/b"\nprompt = "Review $ARGUMENTS."\n',
    );
    const { writer, out, err } = makeWriter();
    commandList({ ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      name: "review",
      description: "Review code",
      argumentHint: "<file>",
      source: expect.any(String),
      model: "a/b",
    });
    expect(err).toEqual([]);
  });

  it("list emits an empty JSON array (not prose) when empty", () => {
    const { writer, out } = makeWriter();
    commandList({ ...ctx, json: true }, writer);
    expect(out).toEqual(["[]"]);
  });

  it("show emits one single-line JSON object round-tripping the template", () => {
    writeCmd(
      "review",
      'schema_version = 1\nkind = "command"\nname = "review"\ndescription = "Review code"\nprompt = "Review $ARGUMENTS carefully."\n',
    );
    const { writer, out } = makeWriter();
    commandShow("review", { ...ctx, json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("\n");
    const parsed = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(parsed.name).toBe("review");
    expect(String(parsed.template)).toContain("Review $ARGUMENTS carefully.");
    expect(typeof parsed.source).toBe("string");
  });

  it("emits a single-line JSON error object on stderr for an unknown command", () => {
    const { writer, out, err } = makeWriter();
    commandShow("ghost", { ...ctx, json: true }, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(JSON.parse(err[0] as string)).toEqual({
      type: "error",
      code: "not_found",
      message: expect.stringContaining("Unknown command"),
    });
    expect(process.exitCode).toBe(1);
  });
});
