/**
 * indexer.ts — The scanner behind `oxagen config build` (design.md §5).
 *
 * Scans `sources` at BOTH workspace and user scope and produces the
 * read-only `consolidated` index: every skill, custom agent definition, MCP
 * server (+ the tools it exposes), command, custom tool, and the
 * CLAUDE.md/.cursorrules/AGENTS.md convention files — across Claude Code,
 * Cursor, and Oxagen's own dialects. Deduped with precedence (workspace
 * beats user on a name clash); every file actually scanned is still recorded
 * in `sourceFiles` regardless of which entry won the dedup.
 *
 * Reuses existing discovery code instead of re-scanning by hand:
 *   - `parseFrontmatter` / `parseToolList` (../agents/loader.js) — the same
 *     frontmatter parser `loadAgents`/`loadCommands` already use for
 *     `.claude/agents`, `.oxagen/agents`, `.claude/commands`, `.oxagen/commands`.
 *   - `resolveWorkspaceConfig` (./resolve.js) — for the effective `sources`
 *     config and for deriving `conventionsByLanguage` from already-resolved
 *     `languages[*].items`.
 *   - `loadSettings` (../settings/resolve.js) + `checkServer` (../mcp/client.js)
 *     — for MCP servers declared in Oxagen's own `settings.json` dialect,
 *     including (optionally) a live tool listing.
 *
 * `.mcp.json` / `.cursor/mcp.json` / `~/.claude.json` (Claude Code and Cursor's
 * own MCP dialects) have no existing Oxagen loader — those are parsed here
 * with a small best-effort reader (flat `{ mcpServers: { name: {...} } }`,
 * no live connection: we can't safely instantiate a fully validated transport
 * from a foreign dialect).
 *
 * Deterministic and side-effect-free (pure filesystem reads, no writes) so
 * it's safely idempotent — the caller (config/write.ts's `writeConsolidated`,
 * driven by `oxagen config build`) is the only place that touches disk.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseArtifactToml } from "@oxagen/agent-artifacts";
import { WORKSPACE_SKILL_DIRS, USER_SKILL_DIRS } from "../skills/loader.js";
import { resolveWorkspaceConfig } from "./resolve.js";
import { loadSettings, type SettingsScope } from "../settings/resolve.js";
import { checkServer } from "../mcp/client.js";
import type {
  ConfigScope,
  ConsolidatedConfig,
  SourceCategories,
  WorkspaceConfig,
} from "./schema.js";

export interface BuildIndexOptions {
  /** Override ~/.oxagen/managed.json (testing) — threaded to resolveWorkspaceConfig. */
  managedConfigPath?: string;
  /** Override ~/.oxagen/user.json (testing) — threaded to resolveWorkspaceConfig. */
  userConfigPath?: string;
  /** Override ~/.oxagen/settings.json (testing) — threaded to loadSettings for the MCP scan. */
  userSettingsPath?: string;
  /** Override the "~" base used to expand user-scope source entries (testing). Defaults to homedir(). */
  userHomeDir?: string;
  /**
   * Best-effort live-connect to every MCP server sourced from Oxagen's own
   * settings.json dialect to list its tools (design.md §5: "+ the tools it
   * exposes"). Off by default — `build` stays fast, deterministic, and
   * offline-safe; `oxagen mcp check` already covers on-demand live listing.
   */
  liveMcpTools?: boolean;
}

// ── Defaults (design.md §4 `sources` example) ───────────────────────────────

const DEFAULT_WORKSPACE_SOURCES: Required<SourceCategories> = {
  conventions: ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".cursor/rules/**"],
  // Single source of truth for the skill scan set — shared with skills/loader.ts.
  skills: [...WORKSPACE_SKILL_DIRS],
  agents: [".oxagen/agents"],
  mcp: [".mcp.json", ".cursor/mcp.json", ".oxagen/settings.json"],
  commands: [".oxagen/commands"],
  tools: [".oxagen/tools"],
};

const DEFAULT_USER_SOURCES: Required<SourceCategories> = {
  conventions: ["~/.claude/CLAUDE.md"],
  skills: [...USER_SKILL_DIRS],
  agents: ["~/.config/oxagen/agents"],
  mcp: ["~/.claude.json", "~/.cursor/mcp.json"],
  commands: ["~/.config/oxagen/commands"],
  tools: ["~/.oxagen/tools"],
};

// ── Small filesystem helpers (no glob dependency — the patterns in play are
//    just "literal path" | "literal dir" | "dir/**") ────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Resolve one `sources` entry to an absolute path: "~/…" via homeDir, else relative to baseDir. */
function resolveSourcePath(
  baseDir: string,
  entry: string,
  homeDir: string,
): string {
  if (entry === "~") return homeDir;
  if (entry.startsWith("~/")) return join(homeDir, entry.slice(2));
  if (entry.startsWith("/")) return entry;
  return join(baseDir, entry);
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Immediate child files of `dir` (non-recursive), sorted. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((f) => join(dir, f))
    .filter((f) => safeStat(f)?.isFile())
    .sort();
}

/** Immediate child directories of `dir` (non-recursive), sorted. */
function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((f) => join(dir, f))
    .filter((f) => safeStat(f)?.isDirectory())
    .sort();
}

/** All files under `dir`, recursive, sorted. */
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of listDirs(dir)) out.push(...walkFiles(entry));
  out.push(...listFiles(dir));
  return out.sort();
}

/** Resolve `sources.*.conventions` entries (files, dirs, or trailing "/**") to concrete files. */
function scanConventionFiles(
  baseDir: string,
  homeDir: string,
  entries: string[],
): string[] {
  const files = new Set<string>();
  for (const raw of entries) {
    const recursive = raw.endsWith("/**");
    const target = resolveSourcePath(
      baseDir,
      recursive ? raw.slice(0, -3) : raw,
      homeDir,
    );
    const st = safeStat(target);
    if (!st) continue;
    if (st.isFile()) files.add(target);
    else if (st.isDirectory())
      for (const f of recursive ? walkFiles(target) : listFiles(target))
        files.add(f);
  }
  return [...files].sort();
}

// ── Per-category scanners ───────────────────────────────────────────────────

type SourceFiles = NonNullable<ConsolidatedConfig["sourceFiles"]>;
type Skills = NonNullable<ConsolidatedConfig["skills"]>;
type Agents = NonNullable<ConsolidatedConfig["agents"]>;
type Commands = NonNullable<ConsolidatedConfig["commands"]>;
type CustomTools = NonNullable<ConsolidatedConfig["customTools"]>;
type McpServers = NonNullable<ConsolidatedConfig["mcpServers"]>;

function scanConventions(
  baseDir: string,
  homeDir: string,
  entries: string[],
  scope: ConfigScope,
  sourceFiles: SourceFiles,
): void {
  for (const file of scanConventionFiles(baseDir, homeDir, entries)) {
    sourceFiles.push({ path: file, scope, kind: "conventions" });
  }
}

/** A skill = a directory containing one canonical skill.toml manifest. */
function scanSkills(
  baseDir: string,
  homeDir: string,
  entries: string[],
  scope: ConfigScope,
  sourceFiles: SourceFiles,
): Skills {
  const out: Skills = [];
  for (const entry of entries) {
    const dir = resolveSourcePath(baseDir, entry, homeDir);
    for (const skillDir of listDirs(dir)) {
      const manifest = join(skillDir, "skill.toml");
      if (!existsSync(manifest)) continue;
      let raw: string;
      try {
        raw = readFileSync(manifest, "utf8");
      } catch {
        continue;
      }
      let artifact;
      try {
        artifact = parseArtifactToml(raw);
      } catch {
        continue;
      }
      if (artifact.kind !== "skill") continue;
      out.push({
        name: artifact.name,
        scope,
        path: skillDir,
        description: artifact.description,
      });
      sourceFiles.push({ path: manifest, scope, kind: "skills" });
    }
  }
  return out;
}

/** Named agents = canonical `.toml` files. */
function scanAgents(
  baseDir: string,
  homeDir: string,
  entries: string[],
  scope: ConfigScope,
  sourceFiles: SourceFiles,
): Agents {
  const out: Agents = [];
  for (const entry of entries) {
    const dir = resolveSourcePath(baseDir, entry, homeDir);
    for (const file of listFiles(dir)) {
      if (!file.endsWith(".toml")) continue;
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let artifact;
      try {
        artifact = parseArtifactToml(raw);
      } catch {
        continue;
      }
      if (artifact.kind !== "agent" || artifact.unresolved_tools.length > 0)
        continue;
      out.push({
        name: artifact.name,
        scope,
        path: file,
        tools: artifact.tools,
      });
      sourceFiles.push({ path: file, scope, kind: "agents" });
    }
  }
  return out;
}

/** Slash commands = canonical `.toml` files. */
function scanCommands(
  baseDir: string,
  homeDir: string,
  entries: string[],
  scope: ConfigScope,
  sourceFiles: SourceFiles,
): Commands {
  const out: Commands = [];
  for (const entry of entries) {
    const dir = resolveSourcePath(baseDir, entry, homeDir);
    for (const file of listFiles(dir)) {
      if (!file.endsWith(".toml")) continue;
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let artifact;
      try {
        artifact = parseArtifactToml(raw);
      } catch {
        continue;
      }
      if (artifact.kind !== "command") continue;
      out.push({ name: artifact.name, scope, path: file });
      sourceFiles.push({ path: file, scope, kind: "commands" });
    }
  }
  return out;
}

/** Custom tools = `.json` files (best-effort — `{ name?, ...jsonSchema }`). */
function scanCustomTools(
  baseDir: string,
  homeDir: string,
  entries: string[],
  scope: ConfigScope,
  sourceFiles: SourceFiles,
): CustomTools {
  const out: CustomTools = [];
  for (const entry of entries) {
    const dir = resolveSourcePath(baseDir, entry, homeDir);
    for (const file of listFiles(dir)) {
      if (!file.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const name =
        (isRecord(parsed) &&
          typeof parsed["name"] === "string" &&
          parsed["name"]) ||
        basename(file).replace(/\.json$/, "");
      out.push({ name, scope, schema: parsed });
      sourceFiles.push({ path: file, scope, kind: "tools" });
    }
  }
  return out;
}

/** MCP servers, from two dialects: Oxagen's own settings.json, and Claude Code/Cursor's `.mcp.json` shape. */
async function scanMcpServers(
  cwd: string,
  homeDir: string,
  workspaceEntries: string[],
  userEntries: string[],
  opts: { liveMcpTools: boolean; userSettingsPath?: string },
  sourceFiles: SourceFiles,
): Promise<McpServers> {
  const out: McpServers = [];

  // Interop dialects first (see scope/precedence note in dedupeByName — same-scope
  // ties resolve to the *last* pushed entry, so pushing Oxagen's own dialect after
  // these lets our richer, fully-typed data win a same-scope name clash).
  const interop: Array<{ entry: string; scope: ConfigScope }> = [
    ...workspaceEntries
      .filter((e) => !e.endsWith(".oxagen/settings.json"))
      .map((entry) => ({ entry, scope: "workspace" as ConfigScope })),
    ...userEntries.map((entry) => ({ entry, scope: "user" as ConfigScope })),
  ];
  for (const { entry, scope } of interop) {
    const file = resolveSourcePath(cwd, entry, homeDir);
    if (!safeStat(file)?.isFile()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed["mcpServers"])) continue;
    sourceFiles.push({ path: file, scope, kind: "mcp" });
    for (const [name, raw] of Object.entries(parsed["mcpServers"])) {
      if (!isRecord(raw)) continue;
      const transport =
        typeof raw["command"] === "string"
          ? "stdio"
          : typeof raw["url"] === "string"
            ? "streamable-http"
            : undefined;
      out.push({ name, scope, transport });
    }
  }

  // Oxagen's own settings.json dialect — fully typed, reuses the existing
  // multi-scope resolver (user < project < local) instead of re-parsing.
  if (workspaceEntries.some((e) => e.endsWith(".oxagen/settings.json"))) {
    const { settings, scopes } = loadSettings({
      cwd,
      userSettingsPath: opts.userSettingsPath,
      noCache: true,
    });
    const toConfigScope: Record<SettingsScope, ConfigScope> = {
      user: "user",
      project: "workspace",
      local: "workspace",
    };
    const definedIn = new Map<string, SettingsScope>();
    for (const sf of scopes) {
      if (
        !sf.settings?.mcpServers ||
        Object.keys(sf.settings.mcpServers).length === 0
      )
        continue;
      sourceFiles.push({
        path: sf.path,
        scope: toConfigScope[sf.scope],
        kind: "mcp",
      });
      for (const name of Object.keys(sf.settings.mcpServers))
        definedIn.set(name, sf.scope);
    }
    for (const [name, config] of Object.entries(settings.mcpServers ?? {})) {
      const scope = toConfigScope[definedIn.get(name) ?? "project"];
      let tools: string[] | undefined;
      const disabled = "disabled" in config && config.disabled;
      if (opts.liveMcpTools && !disabled) {
        try {
          const result = await checkServer(name, config, settings);
          if (result.ok) tools = result.report?.advertised;
        } catch {
          // best-effort — leave tools undefined rather than fail the whole build
        }
      }
      out.push({ name, scope, transport: config.transport, tools });
    }
  }

  return out;
}

/** `conventionsByLanguage` is derived from the already-resolved `languages[*].items` (kind: "convention"). */
function buildConventionsByLanguage(
  resolved: WorkspaceConfig,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [lang, entry] of Object.entries(resolved.languages ?? {})) {
    const ids = (entry.items ?? [])
      .filter((i) => i.kind === "convention")
      .map((i) => i.id);
    if (ids.length > 0) out[lang] = ids;
  }
  return out;
}

/** Precedence-aware dedupe by `name`: workspace beats user (repo > workspace > user > org if ever present). */
function dedupeByName<T extends { name: string; scope: ConfigScope }>(
  items: T[],
): T[] {
  const rank: Record<ConfigScope, number> = {
    org: 0,
    user: 1,
    workspace: 2,
    repo: 3,
  };
  const byName = new Map<string, T>();
  for (const item of items) {
    const existing = byName.get(item.name);
    if (!existing || rank[item.scope] >= rank[existing.scope])
      byName.set(item.name, item);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Top-level orchestration ─────────────────────────────────────────────────

/**
 * Scan `sources` at workspace + user scope and build the consolidated,
 * scope-attributed capability index (design.md §5). Pure — does not write
 * anything; pair with `config/write.ts`'s `writeConsolidated` to persist.
 */
export async function buildConsolidatedIndex(
  cwd: string,
  opts: BuildIndexOptions = {},
): Promise<ConsolidatedConfig> {
  const resolved = resolveWorkspaceConfig(cwd, {
    managedConfigPath: opts.managedConfigPath,
    userConfigPath: opts.userConfigPath,
    noCache: true,
  });
  const sources = resolved.config.sources;
  const scanScopes = sources?.scan ?? ["workspace", "user"];
  const scanWorkspace = scanScopes.includes("workspace");
  const scanUser = scanScopes.includes("user");

  const workspaceSources: SourceCategories = {
    ...DEFAULT_WORKSPACE_SOURCES,
    ...sources?.workspace,
  };
  const userSources: SourceCategories = {
    ...DEFAULT_USER_SOURCES,
    ...sources?.user,
  };
  const homeDir = opts.userHomeDir ?? homedir();

  const sourceFiles: SourceFiles = [];
  const skills: Skills = [];
  const agents: Agents = [];
  const commands: Commands = [];
  const customTools: CustomTools = [];

  if (scanWorkspace) {
    scanConventions(
      cwd,
      homeDir,
      workspaceSources.conventions ?? [],
      "workspace",
      sourceFiles,
    );
    skills.push(
      ...scanSkills(
        cwd,
        homeDir,
        workspaceSources.skills ?? [],
        "workspace",
        sourceFiles,
      ),
    );
    agents.push(
      ...scanAgents(
        cwd,
        homeDir,
        workspaceSources.agents ?? [],
        "workspace",
        sourceFiles,
      ),
    );
    commands.push(
      ...scanCommands(
        cwd,
        homeDir,
        workspaceSources.commands ?? [],
        "workspace",
        sourceFiles,
      ),
    );
    customTools.push(
      ...scanCustomTools(
        cwd,
        homeDir,
        workspaceSources.tools ?? [],
        "workspace",
        sourceFiles,
      ),
    );
  }
  if (scanUser) {
    scanConventions(
      homeDir,
      homeDir,
      userSources.conventions ?? [],
      "user",
      sourceFiles,
    );
    skills.push(
      ...scanSkills(
        homeDir,
        homeDir,
        userSources.skills ?? [],
        "user",
        sourceFiles,
      ),
    );
    agents.push(
      ...scanAgents(
        homeDir,
        homeDir,
        userSources.agents ?? [],
        "user",
        sourceFiles,
      ),
    );
    commands.push(
      ...scanCommands(
        homeDir,
        homeDir,
        userSources.commands ?? [],
        "user",
        sourceFiles,
      ),
    );
    customTools.push(
      ...scanCustomTools(
        homeDir,
        homeDir,
        userSources.tools ?? [],
        "user",
        sourceFiles,
      ),
    );
  }

  const mcpServers = await scanMcpServers(
    cwd,
    homeDir,
    scanWorkspace ? (workspaceSources.mcp ?? []) : [],
    scanUser ? (userSources.mcp ?? []) : [],
    {
      liveMcpTools: opts.liveMcpTools ?? false,
      userSettingsPath: opts.userSettingsPath,
    },
    sourceFiles,
  );

  return {
    generatedAt: new Date().toISOString(),
    skills: dedupeByName(skills),
    agents: dedupeByName(agents),
    mcpServers: dedupeByName(mcpServers),
    commands: dedupeByName(commands),
    customTools: dedupeByName(customTools),
    conventionsByLanguage: buildConventionsByLanguage(resolved.config),
    sourceFiles: sourceFiles.sort(
      (a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope),
    ),
  };
}
