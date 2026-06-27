import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCommands } from "../loader.js";

let dir: string;
let userDir: string;

function writeCmd(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const load = () => loadCommands({ cwd: dir, userCommandsDir: userDir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-slash-"));
  userDir = join(dir, "user-commands");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadCommands", () => {
  it("loads a command with frontmatter and body template", () => {
    writeCmd(".oxagen/commands/review.md", "---\ndescription: Review code\nargument-hint: <file>\nmodel: a/b\n---\nReview $ARGUMENTS.");
    const cmd = load().get("review");
    expect(cmd?.description).toBe("Review code");
    expect(cmd?.argumentHint).toBe("<file>");
    expect(cmd?.model).toBe("a/b");
    expect(cmd?.template).toBe("Review $ARGUMENTS.");
  });

  it("defaults the name to the filename", () => {
    writeCmd(".oxagen/commands/deploy.md", "Do the deploy: $ARGUMENTS");
    expect(load().get("deploy")?.name).toBe("deploy");
  });

  it(".oxagen overrides .claude overrides user", () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "x.md"), "user body");
    writeCmd(".claude/commands/x.md", "claude body");
    expect(load().get("x")?.template).toBe("claude body");
    writeCmd(".oxagen/commands/x.md", "oxagen body");
    expect(load().get("x")?.template).toBe("oxagen body");
  });

  it("ignores files with an empty body", () => {
    writeCmd(".oxagen/commands/empty.md", "---\ndescription: d\n---\n");
    expect(load().has("empty")).toBe(false);
  });

  it("returns an empty registry when nothing is defined", () => {
    expect(load().size).toBe(0);
  });
});
