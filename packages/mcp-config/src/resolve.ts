/**
 * resolve.ts — File resolution and merge logic for the layered MCP settings system.
 *
 * Loads settings from three scopes (in increasing precedence):
 *   1. User (global):   ~/.config/oxagen/settings.json
 *   2. Project (shared): <projectRoot>/.oxagen/settings.json
 *   3. Local (personal): <projectRoot>/.oxagen/settings.local.json
 *
 * Merge semantics:
 *   - mcpServers: keyed merge (later scope replaces entire server entry by name)
 *   - permissions.defaultMcpPolicy: later scope wins
 *   - permissions.mcpServers: keyed merge; within a server, deny/allow APPEND, defaultPolicy overwrites
 *   - toolVisibility: keyed merge (later scope replaces entire entry for that server)
 *   - Environment variables (${VAR}) are expanded in string values at resolution time
 *
 * TRUST BOUNDARY — read before changing precedence. The project and local
 * scopes are read out of the working directory, so running against a cloned
 * repo loads whatever that repo committed, and both outrank the user's own
 * global file. Two of the merged sections widen privilege rather than describe
 * it: `permissions.mcpServers[*].allow` is APPENDED across scopes, and
 * `permissions.defaultMcpPolicy` is a plain overlay-wins scalar. A checked-in
 * `.oxagen/settings.json` can therefore turn a user's global "ask" into
 * "allow", add `allow: ["*"]` to a server the user gated, and register its own
 * `mcpServers` entries. Nothing here asks the user to trust the directory
 * first. The same hazard is documented at the CLI's parallel resolver in
 * apps/cli/src/settings/resolve.ts; any change that broadens what these scopes
 * may set widens the same exposure.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import {
  settingsSchema,
  type Settings,
  type McpServerConfig,
  type Permissions,
  type ServerPermission,
  type ToolVisibility,
} from "./schema";

// ── File Paths ────────────────────────────────────────────────────────────────

const USER_CONFIG_DIR = join(homedir(), ".config", "oxagen");
const USER_SETTINGS_FILE = join(USER_CONFIG_DIR, "settings.json");

const PROJECT_DIR_NAME = ".oxagen";
const PROJECT_SETTINGS_FILE = "settings.json";
const LOCAL_SETTINGS_FILE = "settings.local.json";

export interface ResolveOptions {
  /** Absolute path to the project root. Defaults to cwd(). */
  projectRoot?: string;
  /** Override user settings path (for testing). */
  userSettingsPath?: string;
  /** Override project dir name (for testing). */
  projectDirName?: string;
}

export interface ResolvedScope {
  path: string;
  scope: "user" | "project" | "local";
  settings: Settings;
}

export interface ResolvedConfig {
  /** The merged settings across all scopes. */
  settings: Settings;
  /** Individual scope results for diagnostics (e.g. `oxagen mcp list` showing source). */
  scopes: ResolvedScope[];
  /** Servers with their source scope annotated. */
  serverSources: Record<string, "user" | "project" | "local">;
}

// ── Environment Variable Expansion ────────────────────────────────────────────

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Recursively expand ${VAR} references in string values. Non-string values
 * pass through unchanged. A missing env var is replaced with the empty string
 * and its name is recorded in `warnings`.
 *
 * `warnings` is an in/out parameter, not a return value: a caller that wants
 * the missing-var names must pass its own Set in and read it afterwards.
 * `resolveSettings` below does NOT do that, so today an unset var referenced by
 * e.g. an `Authorization: "Bearer ${TOKEN}"` header silently becomes
 * `"Bearer "` with nothing reported to the user.
 */
export function expandEnvVars(
  value: unknown,
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
  warnings: Set<string> = new Set(),
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_VAR_PATTERN, (_, varName: string) => {
      const resolved = env[varName];
      if (resolved === undefined) {
        warnings.add(varName);
        return "";
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvVars(item, env, warnings));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvVars(v, env, warnings);
    }
    return out;
  }
  return value;
}

// ── File Loading ──────────────────────────────────────────────────────────────

function loadSettingsFile(filePath: string): Settings | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const json: unknown = JSON.parse(raw);
    const result = settingsSchema.safeParse(json);
    if (!result.success) {
      process.stderr.write(
        `Warning: invalid MCP settings in ${filePath}: ${result.error.message}\n`,
      );
      return null;
    }
    return result.data;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Warning: failed to read MCP settings from ${filePath}: ${detail}\n`,
    );
    return null;
  }
}

// ── Merge Logic ───────────────────────────────────────────────────────────────

function mergeServers(
  base: Record<string, McpServerConfig> | undefined,
  overlay: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!overlay) return base;
  if (!base) return overlay;
  // Later scope replaces entire server entry by name (no deep-merge within a server)
  return { ...base, ...overlay };
}

function mergeServerPermissions(
  base: ServerPermission | undefined,
  overlay: ServerPermission | undefined,
): ServerPermission {
  if (!base) return overlay ?? {};
  if (!overlay) return base;
  return {
    // defaultPolicy: overlay wins
    defaultPolicy: overlay.defaultPolicy ?? base.defaultPolicy,
    // allow/deny: append overlay rules to base rules
    allow: [...(base.allow ?? []), ...(overlay.allow ?? [])],
    deny: [...(base.deny ?? []), ...(overlay.deny ?? [])],
  };
}

function mergePermissions(
  base: Permissions | undefined,
  overlay: Permissions | undefined,
): Permissions | undefined {
  if (!overlay) return base;
  if (!base) return overlay;

  const mergedServers: Record<string, ServerPermission> = {
    ...(base.mcpServers ?? {}),
  };
  for (const [name, perms] of Object.entries(overlay.mcpServers ?? {})) {
    mergedServers[name] = mergeServerPermissions(mergedServers[name], perms);
  }

  return {
    defaultMcpPolicy:
      overlay.defaultMcpPolicy ?? base.defaultMcpPolicy ?? "ask",
    mcpServers:
      Object.keys(mergedServers).length > 0 ? mergedServers : undefined,
  };
}

function mergeToolVisibility(
  base: Record<string, ToolVisibility> | undefined,
  overlay: Record<string, ToolVisibility> | undefined,
): Record<string, ToolVisibility> | undefined {
  if (!overlay) return base;
  if (!base) return overlay;
  // Later scope fully replaces visibility for that server name
  return { ...base, ...overlay };
}

function mergeSettings(base: Settings, overlay: Settings): Settings {
  return {
    mcpServers: mergeServers(base.mcpServers, overlay.mcpServers),
    permissions: mergePermissions(base.permissions, overlay.permissions),
    toolVisibility: mergeToolVisibility(
      base.toolVisibility,
      overlay.toolVisibility,
    ),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the effective MCP settings by loading and merging all scope files.
 * Environment variables are expanded in the final merged result.
 */
export function resolveSettings(opts: ResolveOptions = {}): ResolvedConfig {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const userPath = opts.userSettingsPath ?? USER_SETTINGS_FILE;
  const projDirName = opts.projectDirName ?? PROJECT_DIR_NAME;

  const projectSettingsPath = join(
    projectRoot,
    projDirName,
    PROJECT_SETTINGS_FILE,
  );
  const localSettingsPath = join(projectRoot, projDirName, LOCAL_SETTINGS_FILE);

  const scopes: ResolvedScope[] = [];
  let merged: Settings = {};

  // 1. User scope (lowest precedence)
  const userSettings = loadSettingsFile(userPath);
  if (userSettings) {
    scopes.push({ path: userPath, scope: "user", settings: userSettings });
    merged = mergeSettings(merged, userSettings);
  }

  // 2. Project scope
  const projectSettings = loadSettingsFile(projectSettingsPath);
  if (projectSettings) {
    scopes.push({
      path: projectSettingsPath,
      scope: "project",
      settings: projectSettings,
    });
    merged = mergeSettings(merged, projectSettings);
  }

  // 3. Local scope (highest precedence)
  const localSettings = loadSettingsFile(localSettingsPath);
  if (localSettings) {
    scopes.push({
      path: localSettingsPath,
      scope: "local",
      settings: localSettings,
    });
    merged = mergeSettings(merged, localSettings);
  }

  // Expand env vars in the final merged result
  const expanded = expandEnvVars(merged) as Settings;

  // Build server source map (which scope each server came from)
  const serverSources: Record<string, "user" | "project" | "local"> = {};
  // Walk scopes in order so later scopes overwrite the source
  for (const scope of scopes) {
    for (const name of Object.keys(scope.settings.mcpServers ?? {})) {
      serverSources[name] = scope.scope;
    }
  }

  return { settings: expanded, scopes, serverSources };
}

/**
 * Find the project root by walking up from `startDir` (default: cwd) looking
 * for a `.oxagen/` directory. Falls back to `startDir` if none is found (the
 * settings files simply won't exist there).
 *
 * `startDir` is resolved to an absolute path first: a relative path walked with
 * `join(dir, "..")` grows ("." → ".." → "../..") instead of shrinking, so the
 * ascent would never reach a filesystem root and the loop would not terminate.
 * `dirname` on an absolute path is fixed-point at the root on every platform,
 * which is what ends the walk.
 */
export function findProjectRoot(startDir?: string): string {
  const start = startDir ?? process.cwd();
  let dir = resolvePath(start);
  for (;;) {
    if (existsSync(join(dir, PROJECT_DIR_NAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the caller's starting directory
  return start;
}

/**
 * Returns the paths that would be checked for settings files given a project root.
 * Useful for diagnostics and the `oxagen mcp list` command.
 */
export function getSettingsPaths(projectRoot?: string): {
  user: string;
  project: string;
  local: string;
} {
  const root = projectRoot ?? process.cwd();
  return {
    user: USER_SETTINGS_FILE,
    project: join(root, PROJECT_DIR_NAME, PROJECT_SETTINGS_FILE),
    local: join(root, PROJECT_DIR_NAME, LOCAL_SETTINGS_FILE),
  };
}
