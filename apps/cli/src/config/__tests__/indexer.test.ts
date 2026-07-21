import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";
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
  opts = {
    managedConfigPath,
    userConfigPath,
    userHomeDir: homeDir,
    userSettingsPath: join(homeDir, "settings.json"),
  };
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
  it("scans canonical skill.toml manifests from the default workspace skills dir", async () => {
    write(
      ".oxagen/skills/coss-ui/skill.toml",
      serializeArtifactToml({
        schema_version: 1,
        kind: "skill",
        name: "coss-ui",
        description: "Base UI component system.",
        instructions: "Body text.",
        references: [],
      }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills).toEqual([
      {
        name: "coss-ui",
        scope: "workspace",
        path: join(cwd, ".oxagen/skills/coss-ui"),
        description: "Base UI component system.",
      },
    ]);
    expect(result.sourceFiles).toContainEqual({
      path: join(cwd, ".oxagen/skills/coss-ui/skill.toml"),
      scope: "workspace",
      kind: "skills",
    });
  });

  it("ignores a skill directory with no skill.toml", async () => {
    mkdirSync(join(cwd, ".oxagen/skills/not-a-skill"), { recursive: true });
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills).toEqual([]);
  });

  it("workspace beats user on a name clash; both scans still contribute sourceFiles", async () => {
    const skill = (description: string) =>
      serializeArtifactToml({
        schema_version: 1,
        kind: "skill" as const,
        name: "shared",
        description,
        instructions: "Body",
        references: [],
      });
    write(".oxagen/skills/shared/skill.toml", skill("workspace version"));
    write(
      ".config/oxagen/skills/shared/skill.toml",
      skill("user version"),
      homeDir,
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills).toHaveLength(1);
    expect(result.skills?.[0]).toMatchObject({
      name: "shared",
      scope: "workspace",
      description: "workspace version",
    });
    // Both files were scanned even though only one "won" the name.
    expect(
      result.sourceFiles?.some(
        (f) => f.scope === "user" && f.path.includes("shared"),
      ),
    ).toBe(true);
    expect(
      result.sourceFiles?.some(
        (f) => f.scope === "workspace" && f.path.includes("shared"),
      ),
    ).toBe(true);
  });
});

describe("buildConsolidatedIndex — agents", () => {
  it("scans canonical agent TOML and canonical tool slugs", async () => {
    write(
      ".oxagen/agents/reviewer.toml",
      serializeArtifactToml({
        schema_version: 1,
        kind: "agent",
        name: "reviewer",
        description: "Reviews code.",
        developer_instructions: "You review code.",
        tools: ["read_file", "grep"],
        skills: [],
        unresolved_tools: [],
      }),
    );
    write(
      ".oxagen/agents/fixer.toml",
      serializeArtifactToml({
        schema_version: 1,
        kind: "agent",
        name: "fixer",
        description: "Fixes bugs.",
        developer_instructions: "You fix bugs.",
        tools: [],
        skills: [],
        unresolved_tools: [],
      }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.agents).toHaveLength(2);
    const reviewer = result.agents?.find((a) => a.name === "reviewer");
    expect(reviewer).toMatchObject({
      scope: "workspace",
      tools: ["read_file", "grep"],
    });
    const fixer = result.agents?.find((a) => a.name === "fixer");
    expect(fixer).toMatchObject({ scope: "workspace" });
  });

  it("does not execute a foreign Markdown agent in place", async () => {
    write(
      ".claude/agents/foreign.md",
      "---\nname: foreign\n---\n\nForeign agent.\n",
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.agents).toEqual([]);
  });
});

describe("buildConsolidatedIndex — commands and custom tools", () => {
  it("scans canonical command TOML", async () => {
    write(
      ".oxagen/commands/ci-green.toml",
      serializeArtifactToml({
        schema_version: 1,
        kind: "command",
        name: "ci-green",
        description: "Run the full gate.",
        prompt: "Run pnpm gate.",
      }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.commands).toEqual([
      {
        name: "ci-green",
        scope: "workspace",
        path: join(cwd, ".oxagen/commands/ci-green.toml"),
      },
    ]);
  });

  it("scans .oxagen/tools as .json files, deriving name from the file when absent", async () => {
    write(
      ".oxagen/tools/search.json",
      JSON.stringify({ description: "Search the web" }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.customTools).toEqual([
      {
        name: "search",
        scope: "workspace",
        schema: { description: "Search the web" },
      },
    ]);
  });
});

describe("buildConsolidatedIndex — conventions + conventionsByLanguage", () => {
  it("records CLAUDE.md/AGENTS.md as workspace sourceFiles", async () => {
    write("CLAUDE.md", "# Rules\n");
    write("AGENTS.md", "# Agent rules\n");
    const result = await buildConsolidatedIndex(cwd, opts);
    const conventionFiles =
      result.sourceFiles?.filter((f) => f.kind === "conventions") ?? [];
    expect(conventionFiles.map((f) => f.path).sort()).toEqual(
      [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")].sort(),
    );
  });

  it("walks a trailing /** pattern recursively", async () => {
    write(".cursor/rules/a.md", "rule a");
    write(".cursor/rules/nested/b.md", "rule b");
    const result = await buildConsolidatedIndex(cwd, opts);
    const paths =
      result.sourceFiles
        ?.filter((f) => f.kind === "conventions")
        .map((f) => f.path) ?? [];
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
      JSON.stringify({
        mcpServers: {
          linear: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "linear-mcp"],
          },
        },
      }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.mcpServers).toEqual([
      {
        name: "linear",
        scope: "workspace",
        transport: "stdio",
        tools: undefined,
      },
    ]);
    expect(
      result.sourceFiles?.some(
        (f) => f.kind === "mcp" && f.path.endsWith(".oxagen/settings.json"),
      ),
    ).toBe(true);
  });

  it("does NOT attempt a live connection by default (liveMcpTools off) — tools stays undefined", async () => {
    write(
      ".oxagen/settings.json",
      JSON.stringify({
        mcpServers: {
          fake: { transport: "stdio", command: "definitely-not-a-real-binary" },
        },
      }),
    );
    const result = await buildConsolidatedIndex(cwd, opts); // liveMcpTools defaults to false
    expect(result.mcpServers?.[0]).toMatchObject({
      name: "fake",
      tools: undefined,
    });
  });

  it("best-effort parses an interop .mcp.json dialect (Claude Code / Cursor shape)", async () => {
    write(
      ".mcp.json",
      JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"] } },
      }),
    );
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
    const skill = (name: string) =>
      serializeArtifactToml({
        schema_version: 1,
        kind: "skill" as const,
        name,
        description: `${name} description`,
        instructions: `${name} body`,
        references: [],
      });
    write(".oxagen/skills/ws-skill/skill.toml", skill("ws-skill"));
    write(
      ".config/oxagen/skills/user-skill/skill.toml",
      skill("user-skill"),
      homeDir,
    );
    write(
      ".oxagen/workspace.json",
      JSON.stringify({ sources: { scan: ["workspace"] } }),
    );
    const result = await buildConsolidatedIndex(cwd, opts);
    expect(result.skills?.map((s) => s.name)).toEqual(["ws-skill"]);
  });
});

describe("buildConsolidatedIndex — idempotency", () => {
  it("running twice with no filesystem changes produces the same output modulo generatedAt", async () => {
    write(
      ".oxagen/agents/reviewer.toml",
      serializeArtifactToml({
        schema_version: 1,
        kind: "agent",
        name: "reviewer",
        description: "Reviews code.",
        developer_instructions: "Body.",
        tools: [],
        skills: [],
        unresolved_tools: [],
      }),
    );
    write("CLAUDE.md", "# Rules\n");
    const first = await buildConsolidatedIndex(cwd, opts);
    const second = await buildConsolidatedIndex(cwd, opts);
    const strip = (r: typeof first) => ({ ...r, generatedAt: undefined });
    expect(strip(second)).toEqual(strip(first));
  });
});
