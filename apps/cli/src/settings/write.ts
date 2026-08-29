/**
 * write.ts — Writers for `oxagen settings set` and `oxagen settings init`.
 *
 * Writes target a single scope file (user / project / local) — never the merged
 * view — so the layering stays meaningful. Every write is validated against the
 * unified schema before it touches disk, so a `set` can never produce an invalid
 * settings file.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { oxagenSettingsSchema, type OxagenSettings } from "./schema.js";
import {
  getScopePaths,
  clearSettingsCache,
  type SettingsScope,
} from "./resolve.js";
import { atomicWriteFileSync } from "../lib/atomic-write.js";

/** Keys `oxagen settings set` accepts. Complex sections are edited in the file. */
export const SETTABLE_KEYS = [
  "model",
  "workerModel",
  "judgeModel",
  "triageModel",
  "apiUrl",
  "confirmScope",
  "dispatchMode",
  "dispatchMaxConcurrent",
] as const;

/**
 * Keys whose settings.json value is a JSON boolean rather than a string.
 * `writeSettingsValue`'s `value` parameter is always a string (it comes from
 * a CLI arg / panel text buffer) — for these keys it's parsed to `true`/
 * `false` before being written, so the file holds a real boolean and not the
 * string `"true"`, which would fail `oxagenSettingsSchema`'s `z.boolean()`.
 */
const BOOLEAN_SETTABLE_KEYS = new Set<string>(["confirmScope", "dispatchMode"]);

/**
 * Keys whose settings.json value is a JSON number rather than a string. Parsed
 * the same way as booleans so the file holds a real number and not the string
 * form, which would fail the schema's `z.number()`.
 */
const NUMBER_SETTABLE_KEYS = new Set<string>(["dispatchMaxConcurrent"]);

/** `"true"`/`"false"` (case-insensitive, trimmed) → boolean. Throws otherwise. */
function parseBooleanSettingValue(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(
    `invalid boolean value "${raw}" — expected "true" or "false"`,
  );
}

/** A finite number string → number. Throws otherwise. */
function parseNumberSettingValue(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    throw new Error(`invalid number value "${raw}" — expected a number`);
  }
  return n;
}

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
  atomicWriteFileSync(path, JSON.stringify(validated, null, 2) + "\n");
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
    doc[opts.key] = BOOLEAN_SETTABLE_KEYS.has(opts.key)
      ? parseBooleanSettingValue(opts.value)
      : NUMBER_SETTABLE_KEYS.has(opts.key)
        ? parseNumberSettingValue(opts.value)
        : opts.value;
  } else {
    throw new Error(
      `cannot set "${opts.key}". Settable: ${SETTABLE_KEYS.join(", ")}, env.<NAME>. ` +
        `Edit ${path} directly for permissions / hooks / mcpServers.`,
    );
  }

  writeScopeDoc(path, doc as OxagenSettings);
  return path;
}

/**
 * The env var name `applySettingsToEnv` (runtime.ts) would project a
 * `writeSettingsValue` key into, or `undefined` for a key that isn't
 * projected at all (e.g. unsupported keys, which `writeSettingsValue` already
 * rejects before this would matter).
 */
export function envVarForSettingsKey(key: string): string | undefined {
  if (key.startsWith("env.")) return key.slice("env.".length) || undefined;
  if (key === "model" || key === "workerModel") return "OXAGEN_MODEL";
  if (key === "judgeModel") return "OXAGEN_LLM_ADVISOR";
  if (key === "triageModel") return "OXAGEN_LLM_EVALUATOR";
  if (key === "apiUrl") return "OXAGEN_API_URL";
  return undefined;
}

/**
 * True when the shell already exports the env var a `writeSettingsValue` key
 * projects to — meaning `applySettingsToEnv`'s `isUnset` gate (runtime.ts)
 * will skip the value just written, and it stays a silent no-op until the
 * shell var is unset. Callers (the `settings set` command handler) use this
 * to warn at SET time, right when the confusing "✓" is printed, instead of
 * leaving the user to discover it only at the next `config doctor` run.
 */
export function shellShadowsSettingsKey(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const name = envVarForSettingsKey(key);
  if (!name) return false;
  const v = env[name];
  return v !== undefined && v !== "";
}

/**
 * Deliberately does NOT seed `model`: `applySettingsToEnv` (runtime.ts)
 * projects `settings.model` into `OXAGEN_MODEL` whenever the shell hasn't set
 * it, and `resolveModelId` (agent/model.ts) checks `OXAGEN_MODEL` before ever
 * consulting store #2 (`~/.config/oxagen/config.json`). If this starter file
 * planted a `model` value, every fresh `oxagen settings init` would silently
 * mask `oxagen config model <x>` forever. An absent `model` key here means the
 * user's actual model choice (store #2, or the built-in default) governs until
 * they deliberately pin one with `oxagen settings set model <x>`.
 */
const STARTER: OxagenSettings = {
  $schema: "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json",
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
export function writeStarterSettings(opts: InitOptions): {
  path: string;
  created: boolean;
} {
  const paths = getScopePaths(opts);
  const path = paths[opts.scope];
  if (existsSync(path)) return { path, created: false };
  writeScopeDoc(path, STARTER);
  return { path, created: true };
}
