/**
 * settings command — inspect and edit the unified `settings.json`.
 *
 *   oxagen settings                 Show the merged settings + where each scope lives
 *   oxagen settings path            List the three scope files and their status
 *   oxagen settings get <key>       Print a value (dotted, e.g. permissions.defaultMode)
 *   oxagen settings set <key> <val> Write a value (model | apiUrl | env.NAME)
 *   oxagen settings validate        Validate every scope file against the schema
 *   oxagen settings init            Write a documented starter file (project scope)
 *
 * `set` / `init` target a single scope (default: project) so the user/project/
 * local layering stays meaningful.
 *
 * Every handler accepts an optional resolution context (cwd / userSettingsPath)
 * so the command is exercisable in tests without touching the real `~/.config`.
 */
import { existsSync } from "node:fs";
import {
  loadSettings,
  getScopePaths,
  writeSettingsValue,
  writeStarterSettings,
  type SettingsScope,
  type OxagenSettings,
  type ResolveSettingsOptions,
} from "../settings/index.js";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

/** Resolution context shared by every handler (paths come from here in tests). */
export type SettingsCtx = Pick<ResolveSettingsOptions, "cwd" | "userSettingsPath" | "projectDirName">;

function isScope(value: string): value is SettingsScope {
  return (SCOPES as string[]).includes(value);
}

/** Navigate a dotted path (e.g. "permissions.defaultMode") into the settings. */
function getByPath(settings: OxagenSettings, key: string): unknown {
  let cur: unknown = settings;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function settingsShow(ctx: SettingsCtx = {}): void {
  const { settings, scopes } = loadSettings({ ...ctx, noCache: true });
  console.log("Effective settings (merged user → project → local):\n");
  console.log(JSON.stringify(settings, null, 2));
  const present = scopes.filter((s) => s.settings || s.error);
  console.log("\nScopes:");
  if (present.length === 0) {
    console.log("  (no settings files found — run `oxagen settings init`)");
  }
  for (const s of present) {
    const status = s.error ? `⚠ ${s.error}` : "ok";
    console.log(`  ${s.scope.padEnd(8)} ${s.path}  [${status}]`);
  }
}

export function settingsPath(ctx: SettingsCtx = {}): void {
  const paths = getScopePaths(ctx);
  console.log("Settings scope files (lowest → highest precedence):\n");
  for (const scope of SCOPES) {
    const path = paths[scope];
    console.log(`  ${scope.padEnd(8)} ${path}  ${existsSync(path) ? "(exists)" : "(absent)"}`);
  }
}

export function settingsGet(key: string, ctx: SettingsCtx = {}): void {
  const { settings } = loadSettings({ ...ctx, noCache: true });
  const value = getByPath(settings, key);
  if (value === undefined) {
    console.log(`${key}: (not set)`);
    return;
  }
  console.log(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

export function settingsSet(
  key: string,
  value: string,
  scopeArg?: string,
  ctx: SettingsCtx = {},
): void {
  const scope = scopeArg ?? "project";
  if (!isScope(scope)) {
    console.error(`Unknown scope "${scope}". Use one of: ${SCOPES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  try {
    const path = writeSettingsValue({ ...ctx, scope, key, value });
    console.log(`✓ ${key} = ${value}  (${scope}: ${path})`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

export function settingsValidate(ctx: SettingsCtx = {}): void {
  const { scopes } = loadSettings({ ...ctx, noCache: true });
  let ok = true;
  let checked = 0;
  for (const s of scopes) {
    if (!s.settings && !s.error) continue; // absent file — nothing to validate
    checked++;
    if (s.error) {
      ok = false;
      console.error(`✗ ${s.scope} (${s.path}): ${s.error}`);
    } else {
      console.log(`✓ ${s.scope} (${s.path})`);
    }
  }
  if (checked === 0) console.log("No settings files found.");
  if (!ok) process.exitCode = 1;
}

export function settingsInit(scopeArg?: string, ctx: SettingsCtx = {}): void {
  const scope = scopeArg ?? "project";
  if (!isScope(scope)) {
    console.error(`Unknown scope "${scope}". Use one of: ${SCOPES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const { path, created } = writeStarterSettings({ ...ctx, scope });
  if (created) {
    console.log(`✓ Wrote starter settings to ${path}`);
    console.log("  Edit it to add permissions, hooks, env, and MCP servers.");
  } else {
    console.log(`${path} already exists — left untouched.`);
  }
}
