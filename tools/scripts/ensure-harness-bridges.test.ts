/**
 * The harness bridges (#3367, ADR-141): a bridge Git wrote as a text file
 * becomes a link to its target, one that already resolves is left alone,
 * and the check names a bridge that leads nowhere.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIDGES,
  bridgeTarget,
  ensureBridges,
  inspectBridge,
  materializeBridge,
} from "./ensure-harness-bridges.mjs";

let root = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "oxagen-bridges-")));
  mkdirSync(join(root, ".claude", "skills", "triage"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "triage", "SKILL.md"), "x\n");
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "ship.md"), "y\n");
  mkdirSync(join(root, ".agents"));
  mkdirSync(join(root, ".cursor"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What Git writes for a symlink with `core.symlinks=false`. */
function asTextFile(bridge: string, text: string) {
  writeFileSync(join(root, ...bridge.split("/")), text);
}

describe("bridgeTarget", () => {
  it("reads the link text Git writes, whatever its separators and line ending", () => {
    const want = resolve(root, ".claude", "skills");
    expect(bridgeTarget(root, ".agents/skills", "../.claude/skills")).toBe(
      want,
    );
    expect(bridgeTarget(root, ".agents/skills", "../.claude/skills\n")).toBe(
      want,
    );
    expect(bridgeTarget(root, ".agents/skills", "..\\.claude\\skills")).toBe(
      want,
    );
    expect(bridgeTarget(root, ".agents/skills", "../.claude/skills/")).toBe(
      want,
    );
  });

  it("refuses text that cannot be a link inside the repository", () => {
    for (const text of [
      "",
      "   ",
      "/etc",
      "C:\\Windows",
      "c:/Windows",
      "../../outside",
      "..",
      "../.claude/skills\n../.claude/commands",
    ])
      expect(bridgeTarget(root, ".agents/skills", text), text).toBeNull();
  });
});

describe("inspectBridge", () => {
  it("tells a text file from a link, a missing bridge and a broken one", () => {
    expect(inspectBridge(root, ".agents/skills")).toEqual({
      state: "missing",
    });
    asTextFile(".agents/skills", "../.claude/skills");
    expect(inspectBridge(root, ".agents/skills")).toEqual({
      state: "text-file",
      target: join(root, ".claude", "skills"),
    });
    asTextFile(".agents/skills", "../.claude/nothing-here");
    expect(inspectBridge(root, ".agents/skills")).toEqual({ state: "broken" });
    rmSync(join(root, ".agents", "skills"));
    symlinkSync("../.claude/skills", join(root, ".agents", "skills"));
    expect(inspectBridge(root, ".agents/skills")).toEqual({
      state: "resolves",
    });
    rmSync(join(root, ".agents", "skills"));
    symlinkSync("../.claude/gone", join(root, ".agents", "skills"));
    expect(inspectBridge(root, ".agents/skills")).toEqual({ state: "broken" });
  });
});

describe("ensureBridges", () => {
  it("turns both text-file bridges into links that list the skills and commands", () => {
    asTextFile(".agents/skills", "../.claude/skills");
    asTextFile(".cursor/commands", "../.claude/commands\n");
    const changed: string[] = [];
    expect(
      ensureBridges({
        root,
        platform: "linux",
        onChange: (b) => changed.push(b),
      }),
    ).toEqual([]);
    expect(changed).toEqual([...BRIDGES]);
    // The committed form: a relative symlink.
    expect(lstatSync(join(root, ".agents", "skills")).isSymbolicLink()).toBe(
      true,
    );
    expect(readlinkSync(join(root, ".agents", "skills"))).toBe(
      join("..", ".claude", "skills"),
    );
    expect(readdirSync(join(root, ".agents", "skills"))).toEqual(["triage"]);
    expect(readdirSync(join(root, ".cursor", "commands"))).toEqual(["ship.md"]);
    // Again: nothing to do, nothing changed.
    const again: string[] = [];
    expect(
      ensureBridges({
        root,
        platform: "linux",
        onChange: (b) => again.push(b),
      }),
    ).toEqual([]);
    expect(again).toEqual([]);
  });

  it("links to the absolute target on Windows, where the link is a junction", () => {
    asTextFile(".agents/skills", "..\\.claude\\skills");
    const found = inspectBridge(root, ".agents/skills");
    if (found.state !== "text-file") throw new Error(found.state);
    materializeBridge(root, ".agents/skills", found.target, "win32");
    const target = readlinkSync(join(root, ".agents", "skills"));
    expect(isAbsolute(target)).toBe(true);
    expect(readdirSync(join(root, ".agents", "skills"))).toEqual(["triage"]);
  });

  it("only reports under --check, and names each bridge that leads nowhere", () => {
    asTextFile(".agents/skills", "../.claude/skills");
    const problems = ensureBridges({ root, platform: "linux", check: true });
    expect(problems).toEqual([
      ".agents/skills is a text file naming .claude/skills, not a link to it. Run `node tools/scripts/ensure-harness-bridges.mjs`.",
      ".cursor/commands is missing.",
    ]);
    // Check mode changed nothing on disk.
    expect(lstatSync(join(root, ".agents", "skills")).isFile()).toBe(true);
  });

  it("leaves a bridge that names nothing in the repository alone and reports it", () => {
    asTextFile(".agents/skills", "../../somewhere-else");
    symlinkSync("../.claude/commands", join(root, ".cursor", "commands"));
    expect(ensureBridges({ root, platform: "linux" })).toEqual([
      ".agents/skills is not a link to a directory.",
    ]);
    expect(lstatSync(join(root, ".agents", "skills")).isFile()).toBe(true);
  });
});
