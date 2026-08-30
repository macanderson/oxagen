import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { importArtifacts } from "./index.js";
import type { ImportPlatform } from "./types.js";

/**
 * Golden conversion tests.
 *
 * Each supported platform has a fixture source tree under `fixtures/<platform>`
 * and a byte-exact expected output tree under `fixtures/golden/<platform>`.
 * Because `serializeArtifactToml` is deterministic, "did conversion change?"
 * is a byte comparison rather than a judgement call.
 *
 * Regenerate after an intentional conversion change:
 *   UPDATE_GOLDENS=1 pnpm --filter @oxagen/cli test:unit -- src/artifact-import/golden.test.ts
 */

const FIXTURES = join(__dirname, "fixtures");
const GOLDEN = join(FIXTURES, "golden");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

const PLATFORMS: readonly ImportPlatform[] = [
  "claude",
  "codex",
  "cursor",
  "oxagen-legacy",
];

/** The core tool catalog the CLI ships with. */
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

/** Copy a platform's fixture tree into a fresh workspace and import it. */
async function importFixtures(
  platform: ImportPlatform,
  options: Record<string, unknown> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), `import-golden-${platform}-`));
  await cp(join(FIXTURES, platform), join(cwd, sourceDirFor(platform)), {
    recursive: true,
  });
  const receipt = await importArtifacts({
    cwd,
    userHomeDir: join(cwd, "home"),
    scope: "workspace",
    from: [platform],
    toolCatalog: CATALOG,
    writeReceipt: false,
    ...options,
  });
  return { cwd, receipt };
}

/** Every generated .toml under `.oxagen`, keyed by its path relative to it. */
async function collectToml(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".toml")) {
        out.set(
          relative(root, full).split(sep).join("/"),
          await readFile(full, "utf8"),
        );
      }
    }
  }
  await walk(root);
  return out;
}

describe.each(PLATFORMS)("golden conversion: %s", (platform) => {
  let produced: Map<string, string>;

  beforeAll(async () => {
    const { cwd } = await importFixtures(platform);
    produced = await collectToml(join(cwd, ".oxagen"));

    if (UPDATE) {
      const dir = join(GOLDEN, platform);
      await rm(dir, { recursive: true, force: true });
      for (const [rel, content] of produced) {
        const target = join(dir, rel);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
    }
  });

  it("produces exactly the expected set of artifacts", async () => {
    const expected = await collectToml(join(GOLDEN, platform));
    expect([...produced.keys()].sort()).toEqual([...expected.keys()].sort());
  });

  it("produces byte-identical canonical TOML", async () => {
    const expected = await collectToml(join(GOLDEN, platform));
    for (const [rel, content] of expected) {
      expect(produced.get(rel), `mismatch for ${platform}/${rel}`).toBe(
        content,
      );
    }
  });
});

describe("conversion fidelity", () => {
  it("maps Claude's Read to the full intended read-tool set, one-to-many", async () => {
    const { cwd } = await importFixtures("claude");
    const toml = await readFile(
      join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
      "utf8",
    );
    // Read → read_file + list_dir + glob + grep; Write → write_file;
    // Bash → bash; WebSearch → search_web. Order is declaration order,
    // de-duplicated.
    expect(toml).toContain(
      'tools = [ "read_file", "list_dir", "glob", "grep", "write_file", "bash", "search_web" ]',
    );
  });

  it("normalizes a display name into a kebab-case slug", async () => {
    const { cwd } = await importFixtures("claude");
    const toml = await readFile(
      join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
      "utf8",
    );
    expect(toml).toContain('name = "code-reviewer"');
  });

  it("collapses provider model ids to portable tiers", async () => {
    const { cwd } = await importFixtures("claude");
    const reviewer = await readFile(
      join(cwd, ".oxagen", "agents", "code-reviewer.toml"),
      "utf8",
    );
    const captain = await readFile(
      join(cwd, ".oxagen", "agents", "release-captain.toml"),
      "utf8",
    );
    expect(reviewer).toContain('model = "powerful"'); // claude-opus-4-8
    expect(captain).toContain('model = "fast"'); // claude-3-5-haiku
  });

  it("preserves unresolved tools verbatim and marks the agent needs_review", async () => {
    const { cwd, receipt } = await importFixtures("claude");
    const toml = await readFile(
      join(cwd, ".oxagen", "agents", "release-captain.toml"),
      "utf8",
    );
    // `Deploy` has no mapping; `mcp__internal__ship` is an unconfigured MCP
    // server, which is ambiguous rather than guessable. Both survive.
    expect(toml).toContain(
      'unresolved_tools = [ "Deploy", "mcp__internal__ship" ]',
    );

    const item = receipt.items.find((i) => i.name === "release-captain");
    expect(item?.state).toBe("needs_review");
    expect(item?.diagnostics.map((d) => d.code).sort()).toEqual([
      "unresolved_tool_ambiguous_mcp",
      "unresolved_tool_unknown_mapping",
    ]);
  });

  it("maps Cursor's Terminal and Shell to bash without duplication", async () => {
    const { cwd } = await importFixtures("cursor");
    const toml = await readFile(
      join(cwd, ".oxagen", "agents", "pair.toml"),
      "utf8",
    );
    expect(toml).toContain(
      'tools = [ "read_file", "list_dir", "glob", "grep", "bash" ]',
    );
    expect(toml).toContain('unresolved_tools = [ "Composer" ]');
  });

  it("maps Codex identifiers identity-wise and flags unknown ones", async () => {
    const { cwd } = await importFixtures("codex");
    const toml = await readFile(
      join(cwd, ".oxagen", "agents", "refactorer.toml"),
      "utf8",
    );
    expect(toml).toContain('tools = [ "read_file", "edit_file", "bash" ]');
    expect(toml).toContain('unresolved_tools = [ "run_notebook" ]');
  });

  it("records the mapping version on every receipt item", async () => {
    for (const platform of PLATFORMS) {
      const { receipt } = await importFixtures(platform);
      expect(receipt.items.length).toBeGreaterThan(0);
      for (const item of receipt.items) {
        expect(item.mappingVersion, `${platform}/${item.name}`).toBe(
          "2026-07-21.1",
        );
      }
    }
  });
});
