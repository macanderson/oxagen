import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSkill, loadSkills, skillsPromptBlock } from "../loader.js";

let root: string;
let home: string;

function writeSkill(base: string, name: string, instructions: string): void {
  const directory = join(base, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "skill.toml"),
    `schema_version = 1\nkind = "skill"\nname = "${name}"\ndescription = "${name} description"\ninstructions = "${instructions}"\nreferences = []\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oxagen-skills-"));
  home = mkdtempSync(join(tmpdir(), "oxagen-skills-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("loadSkills", () => {
  it("loads canonical bundles with workspace precedence", () => {
    writeSkill(join(home, ".config", "oxagen", "skills"), "review", "user");
    writeSkill(join(root, ".oxagen", "skills"), "review", "workspace");
    mkdirSync(join(root, ".claude", "skills", "foreign"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "foreign", "SKILL.md"),
      "foreign",
    );
    const loaded = loadSkills({ cwd: root, userHomeDir: home });
    expect([...loaded.keys()]).toEqual(["review"]);
    expect(loaded.get("review")?.body).toBe("workspace");
  });

  it("isolates corrupt bundles and resolves one skill", () => {
    const base = join(root, ".oxagen", "skills");
    writeSkill(base, "good", "good");
    mkdirSync(join(base, "bad"), { recursive: true });
    writeFileSync(join(base, "bad", "skill.toml"), "bad toml");
    expect([...loadSkills({ cwd: root, userHomeDir: home }).keys()]).toEqual([
      "good",
    ]);
    expect(getSkill("good", { cwd: root, userHomeDir: home })?.name).toBe(
      "good",
    );
  });
});

describe("skillsPromptBlock", () => {
  it("advertises all skills and expands only selected instructions", () => {
    const skills = [
      {
        name: "a",
        description: "A",
        body: "A body",
        path: "/a",
        source: "/a/skill.toml",
      },
      {
        name: "b",
        description: "B",
        body: "B body",
        path: "/b",
        source: "/b/skill.toml",
      },
    ];
    const prompt = skillsPromptBlock(skills, ["b"]);
    expect(prompt).toContain("- a: A");
    expect(prompt).toContain("B body");
    expect(prompt).not.toContain("A body");
  });
});
