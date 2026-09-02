/**
 * resolve.ts — Loads and merges the unified `settings.json` across three scopes.
 *
 * Precedence (lowest → highest), identical to the MCP config layering and to
 * Claude Code:
 *   1. User (global):   ~/.oxagen/settings.json
 *   2. Project (shared): <projectRoot>/.oxagen/settings.json
 *   3. Local (personal): <projectRoot>/.oxagen/settings.local.json
 *
 * NOTE: Auth credentials (token, org, workspace, gatewayKey) stay in
 * ~/.config/oxagen/config.json — only the settings tier moved.
 *
 * MIGRATION: On first load, if ~/.oxagen/settings.json is absent but the
 * legacy path ~/.config/oxagen/settings.json exists, the legacy file is
 * automatically copied to the new location so existing users lose nothing.
 *
 * Merge rules:
 *   - scalars (model, apiUrl, $schema):       higher scope wins
 *   - env:                                    keyed merge; higher scope wins per key
 *   - permissions.defaultMode/defaultMcpPolicy: higher scope wins
 *   - permissions.allow/deny:                 concatenated (deduped), higher scope last
 *   - permissions.mcpServers, mcpServers, toolVisibility: keyed replace
 *   - hooks:                                  per-event matcher lists concatenated
 *   - unknown (forward-compat) keys:          higher scope wins (shallow)
 *
 * `${VAR}` references in any string value are expanded from the environment at
 * resolution time (reusing @oxagen/mcp-config's expander).
 *
 * TRUST BOUNDARY — read before changing precedence. The project and local
 * scopes come out of the working directory, so cloning a repo and running the
 * CLI in it loads whatever that repo committed. Two of the merged sections are
 * executable, not declarative:
 *
 *   - `hooks` matcher lists are CONCATENATED, so a project file can add a
 *     SessionStart command that runs a shell before the first turn.
 *   - `permissions.allow` is concatenated and `permissions.defaultMode` is a
 *     plain overlay-wins scalar, so a project file can widen (or with
 *     `bypassPermissions`, erase) what the user's global file restricted.
 *
 * Nothing here prompts the user to trust a directory first. Until such a gate
 * exists, running the CLI inside an untrusted checkout is equivalent to running
 * that checkout's code, and any change that broadens what these scopes can set
 * widens that exposure.
 */
import { readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { expandEnvVars } from "@oxagen/mcp-config/resolve";
import {
  oxagenSettingsSchema,
  type OxagenSettings,
  type Permissions,
  type Hooks,
  type HookMatcher,
} from "./schema.js";

export type SettingsScope = "user" | "project" | "local";

export interface ResolveSettingsOptions {
  /** Working directory / project root (where `.oxagen/` lives). Defaults to process.cwd(). */
  cwd?: string;
  /** Override the user settings file path (testing). */
  userSettingsPath?: string;
  /** Override the project directory name (testing). Default ".oxagen". */
  projectDirName?: string;
  /** Skip the per-process cache (testing / after a write). */
  noCache?: boolean;
}

export interface ResolvedScopeFile {
  scope: SettingsScope;
  path: string;
  /** Present only when the file exists and parsed successfully. */
  settings?: OxagenSettings;
  /** Present when the file exists but failed schema validation. */
  error?: string;
}

export interface ResolvedSettings {
  /** Merged, env-expanded settings across every scope that exists. */
  settings: OxagenSettings;
  /** Per-scope diagnostics (path, parsed body, or error) for `oxagen settings`. */
  scopes: ResolvedScopeFile[];
}

const DEFAULT_PROJECT_DIR = ".oxagen";

/** The canonical user (global) settings path — matches Claude Code's ~/.oxagen layout. */
function userSettingsFile(): string {
  return join(homedir(), ".oxagen", "settings.json");
}

/**
 * Legacy path used before the Claude-Code-parity migration.
 * Only consulted when the canonical path does not yet exist.
 */
function legacyUserSettingsFile(): string {
  return join(homedir(), ".config", "oxagen", "settings.json");
}

/**
 * One-time migration: copy `legacyPath` → `canonicalPath` when the canonical
 * file is absent but the legacy file exists. Returns `true` if the copy
 * occurred, `false` otherwise (no-op when canonical already exists, or when
 * legacy is missing, or when the copy fails).
 *
 * Exported so tests can exercise the migration with controlled temp paths
 * rather than touching the real home directory.
 */
export function migrateUserSettings(
  canonicalPath: string,
  legacyPath: string,
): boolean {
  if (existsSync(canonicalPath)) return false;
  if (!existsSync(legacyPath)) return false;
  try {
    mkdirSync(dirname(canonicalPath), { recursive: true });
    copyFileSync(legacyPath, canonicalPath);
    return true;
  } catch {
    // Best-effort — callers fall back to reading the legacy path directly.
    return false;
  }
}

/**
 * Resolve the effective user settings path for the current process.
 * Attempts a one-time migration from the legacy location; falls back to
 * reading from the legacy path if migration fails and the canonical is absent.
 */
function resolvedUserSettingsPath(): string {
  const canonical = userSettingsFile();
  const legacy = legacyUserSettingsFile();
  migrateUserSettings(canonical, legacy);
  if (existsSync(canonical)) return canonical;
  if (existsSync(legacy)) return legacy;
  // Neither exists — return canonical so new writes go to the right place.
  return canonical;
}

/** The three scope file paths for a given project root, in precedence order. */
export function getScopePaths(
  opts: ResolveSettingsOptions = {},
): Record<SettingsScope, string> {
  const root = opts.cwd ?? process.cwd();
  const dir = opts.projectDirName ?? DEFAULT_PROJECT_DIR;
  return {
    user: opts.userSettingsPath ?? resolvedUserSettingsPath(),
    project: join(root, dir, "settings.json"),
    local: join(root, dir, "settings.local.json"),
  };
}

function loadScope(scope: SettingsScope, path: string): ResolvedScopeFile {
  if (!existsSync(path)) return { scope, path };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return {
      scope,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      scope,
      path,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = oxagenSettingsSchema.safeParse(json);
  if (!parsed.success) {
    return {
      scope,
      path,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { scope, path, settings: parsed.data };
}

// ── Merge helpers ───────────────────────────────────────────────────────────

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function mergePermissions(
  base: Permissions | undefined,
  overlay: Permissions | undefined,
): Permissions | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  return {
    defaultMode: overlay.defaultMode ?? base.defaultMode,
    allow:
      base.allow || overlay.allow
        ? dedupe([...(base.allow ?? []), ...(overlay.allow ?? [])])
        : undefined,
    deny:
      base.deny || overlay.deny
        ? dedupe([...(base.deny ?? []), ...(overlay.deny ?? [])])
        : undefined,
    defaultMcpPolicy: overlay.defaultMcpPolicy ?? base.defaultMcpPolicy,
    mcpServers:
      base.mcpServers || overlay.mcpServers
        ? { ...(base.mcpServers ?? {}), ...(overlay.mcpServers ?? {}) }
        : undefined,
  };
}

function mergeHooks(
  base: Hooks | undefined,
  overlay: Hooks | undefined,
): Hooks | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  const concat = (
    a: HookMatcher[] | undefined,
    b: HookMatcher[] | undefined,
  ): HookMatcher[] | undefined =>
    a || b ? [...(a ?? []), ...(b ?? [])] : undefined;
  return {
    SessionStart: concat(base.SessionStart, overlay.SessionStart),
    PreToolUse: concat(base.PreToolUse, overlay.PreToolUse),
    PostToolUse: concat(base.PostToolUse, overlay.PostToolUse),
  };
}

/** Keys with bespoke merge logic; everything else is shallow "overlay wins". */
const STRUCTURED_KEYS = new Set([
  "env",
  "permissions",
  "hooks",
  "mcpServers",
  "toolVisibility",
]);

function mergeSettings(
  base: OxagenSettings,
  overlay: OxagenSettings,
): OxagenSettings {
  const merged: OxagenSettings = { ...base };

  // Pass-through + scalar keys: overlay wins (skip the structured ones below).
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    if (STRUCTURED_KEYS.has(key)) continue;
    (merged as Record<string, unknown>)[key] = value;
  }

  if (base.env || overlay.env) {
    merged.env = { ...(base.env ?? {}), ...(overlay.env ?? {}) };
  }
  merged.permissions = mergePermissions(base.permissions, overlay.permissions);
  merged.hooks = mergeHooks(base.hooks, overlay.hooks);
  if (base.mcpServers || overlay.mcpServers) {
    merged.mcpServers = {
      ...(base.mcpServers ?? {}),
      ...(overlay.mcpServers ?? {}),
    };
  }
  if (base.toolVisibility || overlay.toolVisibility) {
    merged.toolVisibility = {
      ...(base.toolVisibility ?? {}),
      ...(overlay.toolVisibility ?? {}),
    };
  }
  return merged;
}

// ── Public API ──────────────────────────────────────────────────────────────

const cache = new Map<string, ResolvedSettings>();

/** Clear the per-process resolution cache (after a write, or in tests). */
export function clearSettingsCache(): void {
  cache.clear();
}

/**
 * Resolve the effective settings by loading and merging every scope that exists.
 * Results are cached per project root for the life of the process (settings do
 * not change mid-run); pass `noCache` to bypass.
 */
export function loadSettings(
  opts: ResolveSettingsOptions = {},
): ResolvedSettings {
  const paths = getScopePaths(opts);
  const cacheKey = `${paths.user}|${paths.project}|${paths.local}`;
  if (!opts.noCache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const order: SettingsScope[] = ["user", "project", "local"];
  const scopes: ResolvedScopeFile[] = order.map((scope) =>
    loadScope(scope, paths[scope]),
  );

  let merged: OxagenSettings = {};
  for (const sc of scopes) {
    if (sc.settings) merged = mergeSettings(merged, sc.settings);
  }

  const expanded = expandEnvVars(merged) as OxagenSettings;
  const result: ResolvedSettings = { settings: expanded, scopes };
  if (!opts.noCache) cache.set(cacheKey, result);
  return result;
}
