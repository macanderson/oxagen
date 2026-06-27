/**
 * resolve.ts — Loads and merges the unified `settings.json` across three scopes.
 *
 * Precedence (lowest → highest), identical to the MCP config layering and to
 * Claude Code:
 *   1. User (global):   ~/.config/oxagen/settings.json
 *   2. Project (shared): <projectRoot>/.oxagen/settings.json
 *   3. Local (personal): <projectRoot>/.oxagen/settings.local.json
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
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

function userSettingsFile(): string {
  return join(homedir(), ".config", "oxagen", "settings.json");
}

/** The three scope file paths for a given project root, in precedence order. */
export function getScopePaths(opts: ResolveSettingsOptions = {}): Record<
  SettingsScope,
  string
> {
  const root = opts.cwd ?? process.cwd();
  const dir = opts.projectDirName ?? DEFAULT_PROJECT_DIR;
  return {
    user: opts.userSettingsPath ?? userSettingsFile(),
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
    return { scope, path, error: err instanceof Error ? err.message : String(err) };
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
    return { scope, path, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
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

function mergeHooks(base: Hooks | undefined, overlay: Hooks | undefined): Hooks | undefined {
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

function mergeSettings(base: OxagenSettings, overlay: OxagenSettings): OxagenSettings {
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
    merged.mcpServers = { ...(base.mcpServers ?? {}), ...(overlay.mcpServers ?? {}) };
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
export function loadSettings(opts: ResolveSettingsOptions = {}): ResolvedSettings {
  const paths = getScopePaths(opts);
  const cacheKey = `${paths.user}|${paths.project}|${paths.local}`;
  if (!opts.noCache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const order: SettingsScope[] = ["user", "project", "local"];
  const scopes: ResolvedScopeFile[] = order.map((scope) => loadScope(scope, paths[scope]));

  let merged: OxagenSettings = {};
  for (const sc of scopes) {
    if (sc.settings) merged = mergeSettings(merged, sc.settings);
  }

  const expanded = expandEnvVars(merged) as OxagenSettings;
  const result: ResolvedSettings = { settings: expanded, scopes };
  if (!opts.noCache) cache.set(cacheKey, result);
  return result;
}
