import { describe, it, expect } from "vitest";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkillsDir } from "./filesystem";

const SKILL_CONTENT = (name: string) => `---
name: ${name}
description: A ${name} skill.
---

# ${name}

Body content.
`;

describe("scanSkillsDir", () => {
  it("returns an empty array for a non-existent directory", async () => {
    const result = await scanSkillsDir("/nonexistent/path/skills");
    expect(result).toEqual([]);
  });

  it("discovers .skill.md files in a flat directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-test-"));
    try {
      await writeFile(join(dir, "alpha.skill.md"), SKILL_CONTENT("alpha"), "utf8");
      await writeFile(join(dir, "beta.skill.md"), SKILL_CONTENT("beta"), "utf8");
      await writeFile(join(dir, "ignored.md"), "not a skill", "utf8");

      const skills = await scanSkillsDir(dir);
      const slugs = skills.map((s) => s.slug).sort();
      expect(slugs).toEqual(["alpha", "beta"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("discovers .skill.md files nested in subdirectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-test-"));
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "top.skill.md"), SKILL_CONTENT("top"), "utf8");
      await writeFile(join(dir, "sub", "nested.skill.md"), SKILL_CONTENT("nested"), "utf8");

      const skills = await scanSkillsDir(dir);
      const slugs = skills.map((s) => s.slug).sort();
      expect(slugs).toEqual(["nested", "top"]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("ignores non-.skill.md files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-test-"));
    try {
      await writeFile(join(dir, "readme.md"), "# readme", "utf8");
      await writeFile(join(dir, "data.json"), "{}", "utf8");
      await writeFile(join(dir, "valid.skill.md"), SKILL_CONTENT("valid"), "utf8");

      const skills = await scanSkillsDir(dir);
      expect(skills).toHaveLength(1);
      expect(skills[0]?.slug).toBe("valid");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
