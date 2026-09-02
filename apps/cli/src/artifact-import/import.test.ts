import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArtifactToml } from "@oxagen/agent-artifacts";
import { discoverImportCandidates, importArtifacts } from "./index.js";
import { mapForeignTools } from "./tool-mappings.js";

describe("foreign artifact import", () => {
  it("discovers Claude, Codex, Cursor, and legacy Oxagen without mutating sources", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "artifact-import-"));
    const fixtures = [
      [".claude/agents/reviewer.md", "claude"],
      [".agents/skills/testing/SKILL.md", "codex"],
      [".cursor/commands/fix.md", "cursor"],
      [".oxagen/agents/legacy.md", "oxagen-legacy"],
    ] as const;
    for (const [path] of fixtures) {
      await mkdir(join(cwd, path, ".."), { recursive: true });
      await writeFile(
        join(cwd, path),
        `---\nname: ${path.includes("SKILL") ? "testing" : path.split("/").at(-1)?.replace(/\.md$/, "")}\ndescription: Fixture\ntools: Read\n---\n\nInstructions.\n`,
      );
    }

    const candidates = await discoverImportCandidates({
      cwd,
      scope: "workspace",
    });
    expect(new Set(candidates.map((candidate) => candidate.platform))).toEqual(
      new Set(fixtures.map(([, platform]) => platform)),
    );
    expect(await readFile(join(cwd, fixtures[0][0]), "utf8")).toContain(
      "tools: Read",
    );
  });

  it("maps exact foreign permissions one-to-many and preserves unresolved names", () => {
    const result = mapForeignTools(
      "claude",
      ["Read", "Bash", "Unknown", "mcp__github__create_issue"],
      new Set([
        "read_file",
        "list_dir",
        "glob",
        "grep",
        "bash",
        "github_create_issue",
      ]),
      { "github:create_issue": "github_create_issue" },
    );

    expect(result.mapped).toEqual([
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "bash",
      "github_create_issue",
    ]);
    expect(result.unresolved.map((entry) => entry.sourceName)).toEqual([
      "Unknown",
    ]);
    expect(result.mappingVersion).toBe("2026-07-21.1");
  });

  it("imports regular TOML files, replaces an Oxagen symlink, and defaults conflicts to skip", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "artifact-import-"));
    const sourceDir = join(cwd, ".claude", "agents");
    const destinationDir = join(cwd, ".oxagen", "agents");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(destinationDir, { recursive: true });
    const source = join(sourceDir, "reviewer.md");
    await writeFile(
      source,
      "---\nname: reviewer\ndescription: Review\ntools: Read\n---\n\nReview carefully.\n",
    );
    await symlink(source, join(destinationDir, "reviewer.toml"));

    const first = await importArtifacts({
      cwd,
      scope: "workspace",
      from: ["claude"],
      conflict: "replace",
      toolCatalog: new Set(["read_file", "list_dir", "glob", "grep"]),
    });
    expect(first.items[0]?.outcome).toBe("imported");
    const importedPath = join(destinationDir, "reviewer.toml");
    expect(parseArtifactToml(await readFile(importedPath, "utf8")).kind).toBe(
      "agent",
    );

    await writeFile(source, "source changed");
    expect(await readFile(importedPath, "utf8")).toContain("Review carefully.");

    const second = await importArtifacts({
      cwd,
      scope: "workspace",
      from: ["claude"],
      toolCatalog: new Set(["read_file", "list_dir", "glob", "grep"]),
    });
    expect(second.items).toHaveLength(0);
  });

  it("copies skill sidecars into an independent regular bundle", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "artifact-import-bundle-"));
    const sourceDir = join(cwd, ".claude", "skills", "testing");
    await mkdir(join(sourceDir, "references"), { recursive: true });
    await writeFile(
      join(sourceDir, "SKILL.md"),
      "---\nname: testing\ndescription: Test skill\nreferences: references/guide.md\n---\n\nRun the tests.\n",
    );
    await writeFile(join(sourceDir, "references", "guide.md"), "Guide v1\n");

    const receipt = await importArtifacts({
      cwd,
      scope: "workspace",
      from: ["claude"],
      toolCatalog: new Set(),
    });

    expect(receipt.items).toHaveLength(1);
    const destination = join(cwd, ".oxagen", "skills", "testing");
    expect(
      await readFile(join(destination, "references", "guide.md"), "utf8"),
    ).toBe("Guide v1\n");
    expect(
      (await lstat(join(destination, "skill.toml"))).isSymbolicLink(),
    ).toBe(false);
    await writeFile(join(sourceDir, "references", "guide.md"), "Guide v2\n");
    expect(
      await readFile(join(destination, "references", "guide.md"), "utf8"),
    ).toBe("Guide v1\n");
  });
});
