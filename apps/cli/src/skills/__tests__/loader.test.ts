import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, getSkill, skillsPromptBlock } from "../loader.js";
import type { Skill } from "../types.js";

let dir: string;
let home: string;

/** Write a SKILL.md at `<dir>/<rel>/SKILL.md`. */
function writeSkill(base: string, name: string, body: string): void {
  const path = join(base, name, "SKILL.md");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const load = () => loadSkills({ cwd: dir, userHomeDir: home });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-skills-"));
  home = mkdtempSync(join(tmpdir(), "oxagen-skills-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("loadSkills", () => {
  it("loads a skill dir with SKILL.md frontmatter + body", () => {
    writeSkill(
      join(dir, ".oxagen", "skills"),
      "reviewer",
      "---\nname: reviewer\ndescription: Reviews diffs\n---\nHow to review a diff.",
    );
    const skill = load().get("reviewer");
    expect(skill?.description).toBe("Reviews diffs");
    expect(skill?.body).toBe("How to review a diff.");
    expect(skill?.source).toContain("SKILL.md");
    expect(skill?.path).toContain("reviewer");
  });

  it("defaults the name to the directory basename", () => {
    writeSkill(join(dir, ".oxagen", "skills"), "deploy", "Deploy steps.");
    expect(load().get("deploy")?.name).toBe("deploy");
  });

  it("ignores a directory without SKILL.md", () => {
    mkdirSync(join(dir, ".oxagen", "skills", "empty"), { recursive: true });
    expect(load().size).toBe(0);
  });

  it("ignores a SKILL.md with an empty body", () => {
    writeSkill(join(dir, ".oxagen", "skills"), "hollow", "---\nname: hollow\n---\n");
    expect(load().has("hollow")).toBe(false);
  });

  it("workspace .oxagen overrides .claude overrides .agents", () => {
    writeSkill(join(dir, ".agents", "skills"), "x", "agents body");
    writeSkill(join(dir, ".claude", "skills"), "x", "claude body");
    expect(load().get("x")?.body).toBe("claude body");
    writeSkill(join(dir, ".oxagen", "skills"), "x", "oxagen body");
    expect(load().get("x")?.body).toBe("oxagen body");
  });

  it("workspace overrides user scope", () => {
    writeSkill(join(home, ".oxagen", "skills"), "shared", "user body");
    expect(load().get("shared")?.body).toBe("user body");
    writeSkill(join(dir, ".oxagen", "skills"), "shared", "workspace body");
    expect(load().get("shared")?.body).toBe("workspace body");
  });

  it("getSkill returns one skill or null", () => {
    writeSkill(join(dir, ".oxagen", "skills"), "solo", "solo body");
    expect(getSkill("solo", { cwd: dir, userHomeDir: home })?.name).toBe("solo");
    expect(getSkill("nope", { cwd: dir, userHomeDir: home })).toBeNull();
  });
});

describe("skillsPromptBlock", () => {
  const mk = (name: string, description: string, body: string): Skill => ({
    name,
    description,
    body,
    path: `/skills/${name}`,
    source: `/skills/${name}/SKILL.md`,
  });

  it("returns an empty string when there are no skills", () => {
    expect(skillsPromptBlock([])).toBe("");
  });

  it("lists every skill's name + description but no bodies without a selector", () => {
    const block = skillsPromptBlock([
      mk("foo", "does foo", "FOO BODY"),
      mk("bar", "does bar", "BAR BODY"),
    ]);
    expect(block).toContain("## Available skills");
    expect(block).toContain("- foo: does foo");
    expect(block).toContain("- bar: does bar");
    expect(block).not.toContain("FOO BODY");
    expect(block).not.toContain("BAR BODY");
  });

  it("inlines only the selected skills' full bodies", () => {
    const block = skillsPromptBlock(
      [mk("foo", "does foo", "FOO BODY"), mk("bar", "does bar", "BAR BODY")],
      ["foo"],
    );
    expect(block).toContain("### Skill: foo");
    expect(block).toContain("FOO BODY");
    expect(block).not.toContain("### Skill: bar");
    expect(block).not.toContain("BAR BODY");
  });

  it("ignores selector names that do not match a skill", () => {
    const block = skillsPromptBlock([mk("foo", "does foo", "FOO BODY")], ["ghost"]);
    expect(block).toContain("- foo: does foo");
    expect(block).not.toContain("### Skill:");
  });
});
