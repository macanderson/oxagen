import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandList, commandShow, commandNew, type CommandCmdCtx } from "../command.js";

let dir: string;
let ctx: CommandCmdCtx;
let out: string[];
let err: string[];

function writeCmd(name: string, body: string): void {
  const p = join(dir, ".oxagen", "commands", `${name}.md`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-command-"));
  ctx = { cwd: dir, userCommandsDir: join(dir, "user-commands") };
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const text = () => out.join("\n");

describe("command handlers", () => {
  it("lists nothing when empty", () => {
    commandList(ctx);
    expect(text()).toContain("No slash commands");
  });

  it("lists commands with hint and description", () => {
    writeCmd("review", "---\ndescription: Review code\nargument-hint: <file>\n---\nReview $ARGUMENTS.");
    commandList(ctx);
    expect(text()).toContain("/review <file>");
    expect(text()).toContain("Review code");
  });

  it("shows a command's template", () => {
    writeCmd("review", "---\ndescription: Review code\n---\nReview $ARGUMENTS carefully.");
    commandShow("review", ctx);
    expect(text()).toContain("# /review");
    expect(text()).toContain("template");
    expect(text()).toContain("Review $ARGUMENTS carefully.");
  });

  it("errors when showing an unknown command", () => {
    commandShow("ghost", ctx);
    expect(err.join("\n")).toContain("Unknown command");
    expect(process.exitCode).toBe(1);
  });

  it("scaffolds a new command and is idempotent", () => {
    commandNew("deploy", ctx);
    expect(text()).toContain("Created command");
    expect(existsSync(join(dir, ".oxagen", "commands", "deploy.md"))).toBe(true);
    out = [];
    commandNew("deploy", ctx);
    expect(text()).toContain("already exists");
  });

  it("rejects an invalid command name", () => {
    commandNew("bad name", ctx);
    expect(err.join("\n")).toContain("Invalid command name");
    expect(process.exitCode).toBe(1);
  });

  it("a scaffolded command is immediately listable and showable", () => {
    commandNew("fresh", ctx);
    out = [];
    commandList(ctx);
    expect(text()).toContain("/fresh");
  });
});
