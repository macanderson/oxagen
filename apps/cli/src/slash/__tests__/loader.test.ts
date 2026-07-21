import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCommands } from "../loader.js";

let root: string;
let userDirectory: string;

function command(name: string, prompt: string): string {
  return `schema_version = 1\nkind = "command"\nname = "${name}"\ndescription = "${name}"\nargument_hint = "<arg>"\nprompt = "${prompt}"\n`;
}

function write(path: string, value: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oxagen-commands-"));
  userDirectory = join(root, "user-commands");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadCommands", () => {
  it("loads TOML with workspace precedence and ignores Markdown", () => {
    write(join(userDirectory, "review.toml"), command("review", "user"));
    write(
      join(root, ".oxagen", "commands", "review.toml"),
      command("review", "workspace"),
    );
    write(join(root, ".claude", "commands", "foreign.md"), "foreign");
    const loaded = loadCommands({ cwd: root, userCommandsDir: userDirectory });
    expect([...loaded.keys()]).toEqual(["review"]);
    expect(loaded.get("review")?.template).toBe("workspace");
    expect(loaded.get("review")?.argumentHint).toBe("<arg>");
  });

  it("isolates corrupt manifests", () => {
    write(
      join(root, ".oxagen", "commands", "good.toml"),
      command("good", "good"),
    );
    write(join(root, ".oxagen", "commands", "bad.toml"), "bad toml");
    expect([
      ...loadCommands({ cwd: root, userCommandsDir: userDirectory }).keys(),
    ]).toEqual(["good"]);
  });
});
