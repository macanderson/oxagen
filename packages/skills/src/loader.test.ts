import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";
import { describe, expect, it } from "vitest";
import { loadSkillFile, parseSkill } from "./loader";

function skillToml(
  overrides: {
    name?: string;
    references?: string[];
    instructions?: string;
  } = {},
): string {
  return serializeArtifactToml({
    schema_version: 1,
    kind: "skill",
    name: overrides.name ?? "my-skill",
    description: "A test skill.",
    instructions: overrides.instructions ?? "# Body text\n\nSome content here.",
    references: overrides.references ?? [],
    metadata: { weight: "high", category: "test" },
  });
}

describe("parseSkill", () => {
  it("parses canonical TOML and explicit references", () => {
    const parsed = parseSkill(
      skillToml({ references: ["references/guide.md"] }),
    );
    expect(parsed.slug).toBe("my-skill");
    expect(parsed.body).toContain("Body text");
    expect(parsed.metadata?.weight).toBe("high");
    expect(parsed.references).toEqual([
      { path: "references/guide.md", body: "" },
    ]);
  });

  it("rejects Markdown frontmatter and non-skill TOML", () => {
    expect(() => parseSkill("---\nname: old\n---\nbody")).toThrow(
      /invalid_artifact_toml/,
    );
    expect(() =>
      parseSkill(
        'schema_version = 1\nkind = "command"\nname = "x"\ndescription = "x"\nprompt = "x"',
      ),
    ).toThrow(/invalid_skill_artifact/);
  });

  it("applies source and version options", () => {
    const parsed = parseSkill(skillToml(), {
      source: "tenant",
      version: "2.0.0",
    });
    expect(parsed.source).toBe("tenant");
    expect(parsed.version).toBe("2.0.0");
  });
});

describe("loadSkillFile", () => {
  it("resolves contained references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-toml-"));
    try {
      await mkdir(join(directory, "references"));
      await writeFile(join(directory, "references", "guide.md"), "Guide");
      const manifest = join(directory, "skill.toml");
      await writeFile(
        manifest,
        skillToml({ references: ["references/guide.md"] }),
      );
      const loaded = await loadSkillFile(manifest);
      expect(loaded.references[0]?.body).toBe("Guide");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("rejects escaping reference paths before reading", () => {
    expect(() => skillToml({ references: ["../secret.md"] })).toThrow(
      /must stay within/,
    );
  });
});
