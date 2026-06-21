import { describe, it, expect, vi } from "vitest";
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

  it("skips a corrupt .skill.md file (missing frontmatter) without aborting the scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-test-corrupt-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // One valid skill and one corrupt file (no YAML frontmatter → loader throws).
      await writeFile(join(dir, "good.skill.md"), SKILL_CONTENT("good"), "utf8");
      await writeFile(join(dir, "corrupt.skill.md"), "no frontmatter here at all", "utf8");

      const skills = await scanSkillsDir(dir);
      // The good skill still loads — a single bad file does not abort the scan.
      expect(skills.map((s) => s.slug)).toEqual(["good"]);
      // The corrupt file is logged with its path so the author can fix it.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(msg).toContain("failed to load skill file");
      expect(String(meta.path)).toContain("corrupt.skill.md");
    } finally {
      warnSpy.mockRestore();
      await rm(dir, { recursive: true });
    }
  });

  it("skips a corrupt file nested in a subdirectory without aborting the scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-test-corrupt-sub-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "ok.skill.md"), SKILL_CONTENT("ok"), "utf8");
      await writeFile(join(dir, "sub", "bad.skill.md"), "garbage, no frontmatter", "utf8");

      const skills = await scanSkillsDir(dir);
      expect(skills.map((s) => s.slug)).toEqual(["ok"]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      await rm(dir, { recursive: true });
    }
  });
});
