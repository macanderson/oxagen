import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";
import { describe, expect, it, vi } from "vitest";
import { scanSkillsDir } from "./filesystem";

function content(name: string): string {
  return serializeArtifactToml({
    schema_version: 1,
    kind: "skill",
    name,
    description: `A ${name} skill.`,
    instructions: `# ${name}\n\nBody content.`,
    references: [],
  });
}

describe("scanSkillsDir", () => {
  it("returns empty for a missing directory", async () => {
    expect(await scanSkillsDir("/nonexistent/path/skills")).toEqual([]);
  });

  it("discovers nested skill.toml bundles and ignores Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "scan-skills-"));
    try {
      await mkdir(join(root, "alpha"));
      await mkdir(join(root, "nested", "beta"), { recursive: true });
      await writeFile(join(root, "alpha", "skill.toml"), content("alpha"));
      await writeFile(
        join(root, "nested", "beta", "skill.toml"),
        content("beta"),
      );
      await writeFile(join(root, "alpha.skill.md"), "legacy");
      expect(
        (await scanSkillsDir(root)).map((skill) => skill.slug).sort(),
      ).toEqual(["alpha", "beta"]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("isolates a corrupt bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "scan-skills-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await mkdir(join(root, "good"));
      await mkdir(join(root, "bad"));
      await writeFile(join(root, "good", "skill.toml"), content("good"));
      await writeFile(join(root, "bad", "skill.toml"), "not toml");
      expect((await scanSkillsDir(root)).map((skill) => skill.slug)).toEqual([
        "good",
      ]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true });
    }
  });
});
