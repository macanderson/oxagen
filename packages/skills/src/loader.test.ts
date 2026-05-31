import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSkill, loadSkillFile } from "./loader.js";

// ---------------------------------------------------------------------------
// parseSkill
// ---------------------------------------------------------------------------

describe("parseSkill", () => {
  const VALID_RAW = `---
name: my-skill
description: A test skill.
---

# Body text

Some content here.
`;

  it("parses valid frontmatter and returns a Skill", () => {
    const skill = parseSkill(VALID_RAW);
    expect(skill.slug).toBe("my-skill");
    expect(skill.name).toBe("my-skill");
    expect(skill.description).toBe("A test skill.");
    expect(skill.body).toBe("# Body text\n\nSome content here.");
    expect(skill.references).toEqual([]);
    expect(skill.source).toBe("builtin");
    expect(skill.version).toBe("1.0.0");
  });

  it("throws when frontmatter is missing", () => {
    expect(() => parseSkill("No frontmatter here.")).toThrow(
      "Skill file is missing YAML frontmatter",
    );
  });

  it("applies source and version from options", () => {
    const skill = parseSkill(VALID_RAW, { source: "tenant", version: "2.0.0" });
    expect(skill.source).toBe("tenant");
    expect(skill.version).toBe("2.0.0");
  });

  it("extracts reference paths from a References block", () => {
    const raw = `---
name: ref-skill
description: Skill with references.
---

# Intro

Some text.

## References

- path/to/doc.md
- another/file.md → ignored arrow text

## Next Heading

Not a reference.
`;
    const skill = parseSkill(raw);
    expect(skill.references).toHaveLength(2);
    expect(skill.references[0]).toEqual({ path: "path/to/doc.md", body: "" });
    expect(skill.references[1]).toEqual({ path: "another/file.md", body: "" });
  });

  it("returns empty references when there is no References block", () => {
    const skill = parseSkill(VALID_RAW);
    expect(skill.references).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadSkillFile
// ---------------------------------------------------------------------------

describe("loadSkillFile", () => {
  it("loads a skill file and resolves a valid reference path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-test-"));
    try {
      const refContent = "This is the referenced doc.";
      await writeFile(join(dir, "ref.md"), refContent, "utf8");

      const raw = `---
name: with-ref
description: Has a reference.
---

## References

- ref.md
`;
      await writeFile(join(dir, "with-ref.skill.md"), raw, "utf8");

      const skill = await loadSkillFile(join(dir, "with-ref.skill.md"));
      expect(skill.references).toHaveLength(1);
      expect(skill.references[0]?.body).toBe(refContent);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns body: '' when a reference path does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-test-"));
    try {
      const raw = `---
name: missing-ref
description: Has a missing reference.
---

## References

- nonexistent.md
`;
      await writeFile(join(dir, "missing-ref.skill.md"), raw, "utf8");

      const skill = await loadSkillFile(join(dir, "missing-ref.skill.md"));
      expect(skill.references).toHaveLength(1);
      expect(skill.references[0]?.body).toBe("");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
