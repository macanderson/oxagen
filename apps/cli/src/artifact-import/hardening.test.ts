import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importArtifacts } from "./index";
import type { ConflictContext, ImportPlatform } from "./types";

const FIXTURES = join(__dirname, "fixtures");

const CATALOG = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "bash",
  "fetch_web",
  "search_web",
]);

function sourceDirFor(platform: ImportPlatform): string {
  return platform === "oxagen-legacy" ? ".oxagen" : `.${platform}`;
}

async function workspace(platform: ImportPlatform): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `import-hardening-`));
  await cp(join(FIXTURES, platform), join(cwd, sourceDirFor(platform)), {
    recursive: true,
  });
  return cwd;
}

function run(
  cwd: string,
  platform: ImportPlatform,
  options: Record<string, unknown> = {},
) {
  return importArtifacts({
    cwd,
    userHomeDir: join(cwd, "home"),
    scope: "workspace",
    from: [platform],
    toolCatalog: CATALOG,
    writeReceipt: false,
    ...options,
  });
}

async function hashTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile())
        out.set(
          rel,
          createHash("sha256")
            .update(await readFile(full))
            .digest("hex"),
        );
    }
  }
  await walk(root, "");
  return out;
}

describe("source preservation", () => {
  it("preserves the legacy manifest when the source bundle IS the destination", async () => {
    // oxagen-legacy at workspace scope reads and writes the same directory
    // (.oxagen/skills/<name>), so an atomic bundle swap could destroy the
    // original manifest. It must survive alongside the canonical skill.toml.
    const cwd = await workspace("oxagen-legacy");
    const bundle = join(cwd, ".oxagen", "skills", "debugging");
    const before = await readFile(join(bundle, "SKILL.md"), "utf8");

    const receipt = await run(cwd, "oxagen-legacy", { conflict: "replace" });
    expect(receipt.items.find((i) => i.kind === "skill")?.outcome).toBe(
      "imported",
    );

    expect((await readdir(bundle)).sort()).toEqual(["SKILL.md", "skill.toml"]);
    expect(await readFile(join(bundle, "SKILL.md"), "utf8")).toBe(before);
    expect(await readFile(join(bundle, "skill.toml"), "utf8")).toContain(
      'kind = "skill"',
    );
  });

  it("never modifies or deletes a foreign source tree", async () => {
    for (const platform of ["claude", "codex", "cursor"] as const) {
      const cwd = await workspace(platform);
      const sourceRoot = join(cwd, sourceDirFor(platform));
      const before = await hashTree(sourceRoot);

      await run(cwd, platform, { conflict: "replace" });

      const after = await hashTree(sourceRoot);
      expect([...after.keys()].sort(), `${platform} lost source files`).toEqual(
        [...before.keys()].sort(),
      );
      for (const [rel, hash] of before) {
        expect(after.get(rel), `${platform}/${rel} was modified`).toBe(hash);
      }
    }
  });
});

describe("idempotent reruns", () => {
  it("reports `unchanged` on a second run and writes nothing new", async () => {
    const cwd = await workspace("claude");
    const first = await run(cwd, "claude");
    expect(first.items.every((i) => i.outcome === "imported")).toBe(true);

    const producedBefore = await hashTree(join(cwd, ".oxagen"));
    const second = await run(cwd, "claude");

    expect(second.items.length).toBe(first.items.length);
    expect(second.items.every((i) => i.outcome === "unchanged")).toBe(true);

    const producedAfter = await hashTree(join(cwd, ".oxagen"));
    expect(producedAfter).toEqual(producedBefore);
  });

  it("distinguishes an unchanged re-import from a real conflict", async () => {
    const cwd = await workspace("claude");
    await run(cwd, "claude");

    // Diverge one artifact; the rest stay identical.
    await writeFile(
      join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
      'schema_version = 1\nkind = "agent"\nname = "code-reviewer"\ndescription = "Edited locally"\ndeveloper_instructions = "Local."\ntools = []\nskills = []\nunresolved_tools = []\n',
    );

    const receipt = await run(cwd, "claude");
    const byName = new Map(receipt.items.map((i) => [i.name, i.outcome]));
    expect(byName.get("code-reviewer")).toBe("skipped");
    expect(byName.get("release-captain")).toBe("unchanged");
  });

  it("does not litter the destination with staging directories", async () => {
    const cwd = await workspace("claude");
    await run(cwd, "claude");
    await run(cwd, "claude");
    const entries = await readdir(join(cwd, ".oxagen", "agents"));
    expect(entries.filter((n) => n.startsWith(".oxagen-import-"))).toEqual([]);
  });
});

describe("conflict handling", () => {
  async function withExistingAgent(): Promise<string> {
    const cwd = await workspace("claude");
    await mkdir(join(cwd, ".oxagen", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
      'schema_version = 1\nkind = "agent"\nname = "code-reviewer"\ndescription = "Pre-existing"\ndeveloper_instructions = "Mine."\ntools = []\nskills = []\nunresolved_tools = []\n',
    );
    return cwd;
  }

  it("skips by default in non-interactive mode, leaving the original intact", async () => {
    const cwd = await withExistingAgent();
    const receipt = await run(cwd, "claude");

    const item = receipt.items.find((i) => i.name === "code-reviewer");
    expect(item?.outcome).toBe("skipped");
    expect(item?.decision).toBe("skip");
    expect(
      await readFile(
        join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
        "utf8",
      ),
    ).toContain("Pre-existing");
  });

  it("replaces on an explicit replace decision", async () => {
    const cwd = await withExistingAgent();
    const receipt = await run(cwd, "claude", { conflict: "replace" });

    expect(receipt.items.find((i) => i.name === "code-reviewer")?.outcome).toBe(
      "imported",
    );
    expect(
      await readFile(
        join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
        "utf8",
      ),
    ).toContain("Reviews changed code");
  });

  it("renames alongside without touching the original", async () => {
    const cwd = await withExistingAgent();
    await run(cwd, "claude", { conflict: "rename" });

    expect(
      await readFile(
        join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
        "utf8",
      ),
    ).toContain("Pre-existing");
    expect(
      await readFile(
        join(cwd, ".oxagen", "agents", "code-reviewer-imported-2.toml"),
        "utf8",
      ),
    ).toContain("Reviews changed code");
  });

  it("resolves interactively per item, and each decision applies only to its own item", async () => {
    const cwd = await workspace("claude");
    await run(cwd, "claude");
    // Diverge both agents so both are genuine conflicts.
    for (const name of ["code-reviewer", "release-captain"]) {
      await writeFile(
        join(cwd, ".oxagen", "agents", `${name}.toml`),
        `schema_version = 1\nkind = "agent"\nname = "${name}"\ndescription = "Local edit"\ndeveloper_instructions = "Local."\ntools = []\nskills = []\nunresolved_tools = []\n`,
      );
    }

    const asked: string[] = [];
    await run(cwd, "claude", {
      resolveConflict: (context: ConflictContext) => {
        asked.push(context.candidate.name);
        return context.candidate.name === "release-captain"
          ? "replace"
          : "skip";
      },
    });

    expect(asked).toContain("release-captain");
    expect(
      await readFile(
        join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
        "utf8",
      ),
    ).toContain("Local edit");
    expect(
      await readFile(
        join(cwd, ".oxagen", "agents", "release-captain.toml"),
        "utf8",
      ),
    ).toContain("Drives the release checklist");
  });
});

describe("skill bundles", () => {
  it("copies supporting files into an independent Oxagen-owned bundle", async () => {
    const cwd = await workspace("claude");
    await run(cwd, "claude");

    const bundle = join(cwd, ".oxagen", "skills", "testing");
    expect(await readFile(join(bundle, "skill.toml"), "utf8")).toContain(
      'references = [ "checklist.md" ]',
    );
    expect(await readFile(join(bundle, "checklist.md"), "utf8")).toContain(
      "failing test first",
    );

    // Independence: mutating the source must not change the imported bundle.
    await writeFile(
      join(cwd, ".claude", "skills", "testing", "checklist.md"),
      "MUTATED\n",
    );
    expect(await readFile(join(bundle, "checklist.md"), "utf8")).not.toContain(
      "MUTATED",
    );
  });

  it("writes the bundle manifest as a regular file, not a symlink", async () => {
    const cwd = await workspace("claude");
    await run(cwd, "claude");
    const stat = await lstat(
      join(cwd, ".oxagen", "skills", "testing", "skill.toml"),
    );
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
  });
});

describe("containment and symlink safety", () => {
  it("rejects a reference that escapes the bundle", async () => {
    const cwd = await workspace("claude");
    await writeFile(
      join(cwd, ".claude", "skills", "testing", "SKILL.md"),
      "---\nname: escaper\ndescription: Tries to escape.\nreferences: ['../../../etc/passwd']\n---\n\nBody.\n",
    );

    const receipt = await run(cwd, "claude");

    // The escaping bundle is rejected, not activated...
    const escaper = receipt.items.find((i) => i.name === "escaper");
    expect(escaper?.outcome).toBe("rejected");
    expect(escaper?.state).toBe("rejected");
    expect(escaper?.destinationPath).toBeUndefined();
    expect(escaper?.diagnostics.map((d) => d.code)).toContain(
      "artifact_rejected",
    );

    // ...and its valid siblings still import. One hostile item must not abort
    // the run.
    expect(
      receipt.items
        .filter((i) => i.outcome === "imported")
        .map((i) => i.name)
        .sort(),
    ).toEqual(["code-reviewer", "release-captain", "review"]);
    await expect(
      readdir(join(cwd, ".oxagen", "skills", "escaper")),
    ).rejects.toThrow();
  });

  it("keeps a failed item's source file untouched", async () => {
    const cwd = await workspace("claude");
    const manifest = join(cwd, ".claude", "skills", "testing", "SKILL.md");
    const body =
      "---\nname: escaper\ndescription: Tries to escape.\nreferences: ['../../../etc/passwd']\n---\n\nBody.\n";
    await writeFile(manifest, body);

    await run(cwd, "claude", { conflict: "replace" });

    expect(await readFile(manifest, "utf8")).toBe(body);
  });

  it("replaces an .oxagen symlink with a regular file and leaves the target alone", async () => {
    const cwd = await workspace("claude");
    const foreign = join(cwd, ".claude", "agents", "Code Reviewer.md");
    await mkdir(join(cwd, ".oxagen", "agents"), { recursive: true });
    const link = join(cwd, ".oxagen", "agents", "code-reviewer.toml");
    await symlink(foreign, link);

    const before = await readFile(foreign, "utf8");
    await run(cwd, "claude", { conflict: "replace" });

    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, "utf8")).toContain("schema_version = 1");
    // The symlink target — a foreign source file — is untouched.
    expect(await readFile(foreign, "utf8")).toBe(before);
  });
});

describe("receipts", () => {
  it("records provenance, mapping version, decision, and outcome per item", async () => {
    const cwd = await workspace("claude");
    const receipt = await run(cwd, "claude");

    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.scope).toBe("workspace");
    expect(receipt.dryRun).toBe(false);

    for (const item of receipt.items) {
      expect(item.sourcePath).toBeTruthy();
      expect(item.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(item.artifactHash).toMatch(/^[0-9a-f]{64}$/);
      expect(item.mappingVersion).toBe("2026-07-21.1");
      expect(["skip", "replace", "rename"]).toContain(item.decision);
      expect(["imported", "skipped", "rejected", "unchanged"]).toContain(
        item.outcome,
      );
    }
  });

  it("records skipped conflicts rather than omitting them", async () => {
    const cwd = await workspace("claude");
    await mkdir(join(cwd, ".oxagen", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
      'schema_version = 1\nkind = "agent"\nname = "code-reviewer"\ndescription = "Pre-existing"\ndeveloper_instructions = "Mine."\ntools = []\nskills = []\nunresolved_tools = []\n',
    );

    const receipt = await run(cwd, "claude");
    const skipped = receipt.items.filter((i) => i.outcome === "skipped");
    expect(skipped.map((i) => i.name)).toEqual(["code-reviewer"]);
  });

  it("writes nothing during a dry run, including the receipt", async () => {
    const cwd = await workspace("claude");
    const receipt = await run(cwd, "claude", {
      dryRun: true,
      writeReceipt: true,
    });

    expect(receipt.dryRun).toBe(true);
    expect(receipt.items.length).toBeGreaterThan(0);
    await expect(readdir(join(cwd, ".oxagen"))).rejects.toThrow();
  });
});
