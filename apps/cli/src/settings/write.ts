/**
 * write.ts — Writers for `oxagen settings set` and `oxagen settings init`.
 *
 * Writes target a single scope file (user / project / local) — never the merged
 * view — so the layering stays meaningful. Every write is validated against the
 * unified schema before it touches disk, so a `set` can never produce an invalid
 * settings file.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { oxagenSettingsSchema, type OxagenSettings } from "./schema.js";
import { getScopePaths, clearSettingsCache, type SettingsScope } from "./resolve.js";

/** Keys `oxagen settings set` accepts. Complex sections are edited in the file. */
export const SETTABLE_KEYS = ["model", "apiUrl"] as const;

export interface WriteValueOptions {
  scope: SettingsScope;
  /** "model", "apiUrl", or "env.<NAME>". */
  key: string;
  value: string;
  cwd?: string;
  userSettingsPath?: string;
  projectDirName?: string;
}

/** Read a single scope file as a raw JSON object (empty if absent). */
export function readScopeDoc(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`existing settings file is not a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

/** Validate and write a settings document to a scope file, busting the cache. */
export function writeScopeDoc(path: string, doc: OxagenSettings): void {
  const validated = oxagenSettingsSchema.parse(doc);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", "utf8");
  clearSettingsCache();
}

/**
 * Set a single value in a scope file. Supports scalar keys (`model`, `apiUrl`)
 * and env vars via the `env.NAME` form. Returns the path written.
 */
export function writeSettingsValue(opts: WriteValueOptions): string {
  const paths = getScopePaths(opts);
  const path = paths[opts.scope];
  const doc = readScopeDoc(path);

  if (opts.key.startsWith("env.")) {
    const name = opts.key.slice("env.".length);
    if (!name) throw new Error('env key must be "env.<NAME>"');
    const env = (doc["env"] as Record<string, string> | undefined) ?? {};
    env[name] = opts.value;
    doc["env"] = env;
  } else if ((SETTABLE_KEYS as readonly string[]).includes(opts.key)) {
    doc[opts.key] = opts.value;
  } else {
    throw new Error(
      `cannot set "${opts.key}". Settable: ${SETTABLE_KEYS.join(", ")}, env.<NAME>. ` +
        `Edit ${path} directly for permissions / hooks / mcpServers.`,
    );
  }

  writeScopeDoc(path, doc as OxagenSettings);
  return path;
}

const STARTER: OxagenSettings = {
  $schema: "https://oxagen.sh/schemas/cli-settings.json",
  model: "anthropic/claude-sonnet-4.6",
  env: {},
  permissions: {
    defaultMode: "default",
    deny: ["Bash(rm -rf*)", "Write(.env*)", "Read(.env*)"],
    allow: [],
  },
  hooks: {
    PreToolUse: [],
    PostToolUse: [],
    SessionStart: [],
  },
};

export interface InitOptions {
  scope: SettingsScope;
  cwd?: string;
  userSettingsPath?: string;
  projectDirName?: string;
}

/**
 * Write a documented starter settings file for a scope. Returns the path and
 * whether it was newly created (false = already existed, left untouched).
 */
export function writeStarterSettings(opts: InitOptions): { path: string; created: boolean } {
  const paths = getScopePaths(opts);
  const path = paths[opts.scope];
  if (existsSync(path)) return { path, created: false };
  writeScopeDoc(path, STARTER);
  return { path, created: true };
}
