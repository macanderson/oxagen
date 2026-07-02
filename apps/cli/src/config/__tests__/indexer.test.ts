import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConsolidatedIndex, type BuildIndexOptions } from "../indexer.js";
import { clearWorkspaceConfigCache } from "../resolve.js";

let cwd: string;
let homeDir: string;
let managedConfigPath: string;
let userConfigPath: string;
let opts: BuildIndexOptions;

function write(relPath: string, content: string, base = cwd): void {
  const full = join(base, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-indexer-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-indexer-home-"));
  managedConfigPath = join(homeDir, "managed.json");
  userConfigPath = join(homeDir, "user.json");
  opts = { managedConfigPath, userConfigPath, userHomeDir: homeDir, userSettingsPath: join(homeDir, "settings.json") };
  clearWorkspaceConfigCache();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  clearWorkspaceConfigCache();
});

describe("buildConsolidatedIndex — empty workspace", () => {
  it("returns empty arrays and a generatedAt timestamp when nothing is present", async () => {
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.generatedAt).toBeTruthy();
    expect(result.skills).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result.customTools).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.sourceFiles).toEqual([]);
  });
});

describe("buildConsolidatedIndex — skills", () => {
  it("scans SKILL.md frontmatter from the default workspace skills dirs", async () => {
    write(
      ".agents/skills/coss-ui/SKILL.md",
      "---\nname: coss-ui\ndescription: Base UI component system.\n---\n\nBody text.\n",
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills).toEqual([
      { name: "coss-ui", scope: "workspace", path: join(cwd, ".agents/skills/coss-ui"), description: "Base UI component system." },
    ]);
    expect(result.sourceFiles).toContainEqual({
      path: join(cwd, ".agents/skills/coss-ui/SKILL.md"),
      scope: "workspace",
      kind: "skills",
    });
  });

  it("ignores a skill directory with no SKILL.md", async () => {
    mkdirSync(join(cwd, ".agents/skills/not-a-skill"), { recursive: true });
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills).toEqual([]);
  });

  it("workspace beats user on a name clash; both scans still contribute sourceFiles", async () => {
    write(".agents/skills/shared/SKILL.md", "---\nname: shared\ndescription: workspace version\n---\nBody\n");
    write(".claude/skills/shared/SKILL.md", "---\nname: shared\ndescription: user version\n---\nBody\n", homeDir);
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills).toHaveLength(1);
    expect(result.skills?.[0]).toMatchObject({ name: "shared", scope: "workspace", description: "workspace version" });
    // Both files were scanned even though only one "won" the name.
    expect(result.sourceFiles?.some((f) => f.scope === "user" && f.path.includes("shared"))).toBe(true);
    expect(result.sourceFiles?.some((f) => f.scope === "workspace" && f.path.includes("shared"))).toBe(true);
  });
});

describe("buildConsolidatedIndex — agents", () => {
  it("scans .claude/agents and .oxagen/agents, parsing tools frontmatter", async () => {
    write(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews code.\ntools: Read, Grep\n---\n\nYou review code.\n");
    write(".oxagen/agents/fixer.md", "---\ndescription: Fixes bugs.\n---\n\nYou fix bugs.\n");
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.agents).toHaveLength(2);
    const reviewer = result.agents?.find((a) => a.name === "reviewer");
    expect(reviewer).toMatchObject({ scope: "workspace", tools: ["Read", "Grep"] });
    const fixer = result.agents?.find((a) => a.name === "fixer"); // name falls back to filename
    expect(fixer).toMatchObject({ scope: "workspace" });
  });

  it("skips a .md file with no body (matches loadAgents' usable-agent check)", async () => {
    write(".claude/agents/empty.md", "---\nname: empty\n---\n\n");
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.agents).toEqual([]);
  });
});

describe("buildConsolidatedIndex — commands and custom tools", () => {
  it("scans .claude/commands as .md files", async () => {
    write(".claude/commands/ci-green.md", "---\ndescription: Run the full gate.\n---\n\nRun `pnpm gate`.\n");
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.commands).toEqual([{ name: "ci-green", scope: "workspace", path: join(cwd, ".claude/commands/ci-green.md") }]);
  });

  it("scans .oxagen/tools as .json files, deriving name from the file when absent", async () => {
    write(".oxagen/tools/search.json", JSON.stringify({ description: "Search the web" }));
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.customTools).toEqual([
      { name: "search", scope: "workspace", schema: { description: "Search the web" } },
    ]);
  });
});

describe("buildConsolidatedIndex — conventions + conventionsByLanguage", () => {
  it("records CLAUDE.md/AGENTS.md as workspace sourceFiles", async () => {
    write("CLAUDE.md", "# Rules\n");
    write("AGENTS.md", "# Agent rules\n");
    const result = await buildConsolidatedIndex(cwd, opts);
    const conventionFiles = result.sourceFiles?.filter((f) => f.kind === "conventions") ?? [];
    expect(conventionFiles.map((f) => f.path).sort()).toEqual(
      [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")].sort(),
    );
  });

  it("walks a trailing /** pattern recursively", async () => {
    write(".cursor/rules/a.md", "rule a");
    write(".cursor/rules/nested/b.md", "rule b");
    const result = await buildConsolidatedIndex(cwd, opts);
    const paths = result.sourceFiles?.filter((f) => f.kind === "conventions").map((f) => f.path) ?? [];
    expect(paths).toContain(join(cwd, ".cursor/rules/a.md"));
    expect(paths).toContain(join(cwd, ".cursor/rules/nested/b.md"));
  });

  it("derives conventionsByLanguage from resolved languages[*].items (kind: convention)", async () => {
    write(
      ".oxagen/workspace.json",
      JSON.stringify({
        languages: {
          typescript: {
            items: [
              { id: "no-any", kind: "rule", origin: "manual" },
              { id: "ui-import", kind: "convention", origin: "manual" },
            ],
          },
        },
      }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.conventionsByLanguage).toEqual({ typescript: ["ui-import"] });
  });
});

describe("buildConsolidatedIndex — mcp servers", () => {
  it("reads Oxagen's own settings.json dialect via the multi-scope settings resolver", async () => {
    write(
      ".oxagen/settings.json",
      JSON.stringify({ mcpServers: { linear: { transport: "stdio", command: "npx", args: ["-y", "linear-mcp"] } } }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.mcpServers).toEqual([{ name: "linear", scope: "workspace", transport: "stdio", tools: undefined }]);
    expect(result.sourceFiles?.some((f) => f.kind === "mcp" && f.path.endsWith(".oxagen/settings.json"))).toBe(true);
  });

  it("does NOT attempt a live connection by default (liveMcpTools off) — tools stays undefined", async () => {
    write(
      ".oxagen/settings.json",
      JSON.stringify({ mcpServers: { fake: { transport: "stdio", command: "definitely-not-a-real-binary" } } }),
    );
    const result = await buildConsolidatedIndex(cwd, opts); // liveMcpTools defaults to false
    expect(result.mcpServers?.[0]).toMatchObject({ name: "fake", tools: undefined });
  });

  it("best-effort parses an interop .mcp.json dialect (Claude Code / Cursor shape)", async () => {
    write(".mcp.json", JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"] } } }));
    const result = await buildConsolidatedIndex(cwd, opts);
    const github = result.mcpServers?.find((s) => s.name === "github");
    expect(github).toMatchObject({ scope: "workspace", transport: "stdio" });
  });

  it("ignores a malformed .mcp.json instead of throwing", async () => {
    write(".mcp.json", "{ not valid json");
    await expect(buildConsolidatedIndex(cwd, opts)).resolves.toBeDefined();
  });
});

describe("buildConsolidatedIndex — sources.scan restricts which scopes run", () => {
  it('scan: ["workspace"] skips user-scope directories entirely', async () => {
    write(".claude/skills/ws-skill/SKILL.md", "---\nname: ws-skill\n---\nBody\n");
    write(".claude/skills/user-skill/SKILL.md", "---\nname: user-skill\n---\nBody\n", homeDir);
    write(".oxagen/workspace.json", JSON.stringify({ sources: { scan: ["workspace"] } }));
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills?.map((s) => s.name)).toEqual(["ws-skill"]);
  });
});

describe("buildConsolidatedIndex — idempotency", () => {
  it("running twice with no filesystem changes produces the same output modulo generatedAt", async () => {
    write(".claude/agents/reviewer.md", "---\nname: reviewer\n---\n\nBody.\n");
    write("CLAUDE.md", "# Rules\n");
    const first = await buildConsolidatedIndex(cwd, opts);
    const second = await buildConsolidatedIndex(cwd, opts);
    const strip = (r: typeof first) => ({ ...r, generatedAt: undefined });
    expect(strip(second)).toEqual(strip(first));
  });
});
