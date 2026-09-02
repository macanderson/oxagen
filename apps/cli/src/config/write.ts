/**
 * write.ts — Typed, scope-aware writers for `oxagen config set/add/remove/…`.
 *
 * Every writer targets a single scope file (workspace / user / repo) — never
 * the merged view, mirroring `../settings/write.ts` — and always reads the
 * scope file fresh, mutates only the keys it owns, and writes back the WHOLE
 * document, so sibling sections another writer (or a human) put there survive
 * untouched (deep-merge-by-read, never clobber).
 *
 * `org` (`managed.json`) is provisioned by the organization and implicitly
 * locked (schema.ts, resolve.ts) — every writer here refuses it up front via
 * {@link assertWritableScope}.
 *
 * Every write is validated against `workspaceConfigSchema` before it touches
 * disk (same discipline as `../settings/write.ts`'s `writeScopeDoc`), and
 * busts the per-process resolution cache so a `resolveWorkspaceConfig` call
 * right after a write sees it.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { readScopeDoc } from "../settings/write.js";
import {
  workspaceConfigSchema,
  languageItemSchema,
  type ConfigScope,
  type LanguageItem,
  type VisionConfig,
  type LanguageVoice,
  type WorktreeSeed,
  type WorktreesConfig,
  type ConsolidatedConfig,
} from "./schema.js";
import {
  getConfigScopePaths,
  clearWorkspaceConfigCache,
  type ResolveWorkspaceConfigOptions,
} from "./resolve.js";

export interface ConfigWriteCtx extends ResolveWorkspaceConfigOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
}

/** Throws for `scope === "org"` — managed.json is org-provisioned and read-only to the CLI. */
export function assertWritableScope(scope: ConfigScope): void {
  if (scope === "org") {
    throw new Error(
      "managed.json (org scope) is provisioned by your organization and read-only to the CLI — " +
        "write to workspace, user, or repo scope instead.",
    );
  }
}

function scopePath(scope: ConfigScope, ctx: ConfigWriteCtx): string {
  const cwd = ctx.cwd ?? process.cwd();
  return getConfigScopePaths(cwd, ctx)[scope];
}

/** Validate a full document against the schema and write it, busting the resolution cache. */
export function writeConfigScopeDoc(
  path: string,
  doc: Record<string, unknown>,
): void {
  const validated = workspaceConfigSchema.parse(doc);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(validated, null, 2) + "\n");
  clearWorkspaceConfigCache();
}

/**
 * Segments that address `Object.prototype` machinery rather than a config key.
 * Assigning through one of these mutates the document's prototype instead of
 * writing an own property, so the value never reaches JSON and the write
 * reports success while doing nothing. Refuse them by name instead.
 */
const RESERVED_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Set `doc[a][b]...[z] = value`, creating intermediate objects as needed. Mutates `doc`. */
function setAtPath(
  doc: Record<string, unknown>,
  dottedPath: string,
  value: unknown,
): void {
  const segments = dottedPath.split(".");
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new Error(`invalid dotted path: "${dottedPath}"`);
  }
  const reserved = segments.find((s) => RESERVED_PATH_SEGMENTS.has(s));
  if (reserved !== undefined) {
    throw new Error(
      `cannot set "${dottedPath}": "${reserved}" is a reserved JavaScript property name, ` +
        `not a config key — a write there would be silently dropped.`,
    );
  }
  let cur = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cur[key];
    if (next === undefined || next === null) {
      const created: Record<string, unknown> = {};
      cur[key] = created;
      cur = created;
    } else if (typeof next === "object" && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
    } else {
      throw new Error(
        `cannot set "${dottedPath}": "${segments.slice(0, i + 1).join(".")}" is not an object ` +
          `(found ${Array.isArray(next) ? "an array" : typeof next})`,
      );
    }
  }
  cur[segments[segments.length - 1]!] = value;
}

/** `"3"` → `3`, `"true"` → `true`, `'{"a":1}'` → `{a:1}`; anything that isn't valid JSON stays a string. */
function parseCliValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Programmatic (already-typed) form of {@link setPath} — used by the indexer and other internals. */
export function setValueAtPath(
  scope: ConfigScope,
  dottedPath: string,
  value: unknown,
  ctx: ConfigWriteCtx = {},
): string {
  assertWritableScope(scope);
  const path = scopePath(scope, ctx);
  const doc = readScopeDoc(path);
  setAtPath(doc, dottedPath, value);
  writeConfigScopeDoc(path, doc);
  return path;
}

/**
 * Set a value at a dotted path (e.g. "vision.statement", "packageManagers.primary")
 * in one scope file. `rawValue` is parsed as JSON when possible (numbers, booleans,
 * arrays, objects) and falls back to a plain string otherwise. Returns the path written.
 */
export function setPath(
  scope: ConfigScope,
  dottedPath: string,
  rawValue: string,
  ctx: ConfigWriteCtx = {},
): string {
  return setValueAtPath(scope, dottedPath, parseCliValue(rawValue), ctx);
}

export interface UnsetPathResult {
  path: string;
  /** False when the dotted path wasn't set in that scope file to begin with. */
  removed: boolean;
}

/**
 * Delete the value at a dotted path from one scope file, pruning any parent
 * objects the removal leaves empty (so an unset never strands `{"vcs":{}}`
 * husks in the file). A value at a lower-authority tier that this one was
 * shadowing simply resurfaces on the next resolve — that's the tiering
 * working, not a bug.
 */
export function unsetPath(
  scope: ConfigScope,
  dottedPath: string,
  ctx: ConfigWriteCtx = {},
): UnsetPathResult {
  assertWritableScope(scope);
  const path = scopePath(scope, ctx);
  const doc = readScopeDoc(path);
  const segments = dottedPath.split(".");
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new Error(`invalid dotted path: "${dottedPath}"`);
  }
  // Walk down to the leaf's parent, remembering the chain for the prune pass.
  const chain: { parent: Record<string, unknown>; key: string }[] = [];
  let cur: Record<string, unknown> = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cur[key];
    if (
      next === undefined ||
      next === null ||
      typeof next !== "object" ||
      Array.isArray(next)
    ) {
      return { path, removed: false };
    }
    chain.push({ parent: cur, key });
    cur = next as Record<string, unknown>;
  }
  const leafKey = segments[segments.length - 1]!;
  if (!(leafKey in cur)) return { path, removed: false };
  delete cur[leafKey];
  for (let i = chain.length - 1; i >= 0; i--) {
    const { parent, key } = chain[i]!;
    const child = parent[key];
    if (
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.keys(child).length === 0
    ) {
      delete parent[key];
    } else {
      break;
    }
  }
  writeConfigScopeDoc(path, doc);
  return { path, removed: true };
}

interface RawLanguageEntry {
  voice?: LanguageVoice;
  items?: LanguageItem[];
}

function languagesOf(
  doc: Record<string, unknown>,
): Record<string, RawLanguageEntry> {
  return (
    (doc["languages"] as Record<string, RawLanguageEntry> | undefined) ?? {}
  );
}

/** Add or replace (by `item.id`) a rule/preference/policy/convention/reference for `lang`. */
export function addLanguageItem(
  scope: ConfigScope,
  lang: string,
  item: LanguageItem,
  ctx: ConfigWriteCtx = {},
): string {
  assertWritableScope(scope);
  const parsed = languageItemSchema.parse(item);
  const path = scopePath(scope, ctx);
  const doc = readScopeDoc(path);
  const languages = languagesOf(doc);
  const entry = languages[lang] ?? {};
  const items = entry.items ?? [];
  const idx = items.findIndex((i) => i.id === parsed.id);
  if (idx >= 0) items[idx] = parsed;
  else items.push(parsed);
  languages[lang] = { ...entry, items };
  doc["languages"] = languages;
  writeConfigScopeDoc(path, doc);
  return path;
}

export interface RemoveItemResult {
  path: string;
  removed: boolean;
  /** Languages the item was actually removed from (usually zero or one). */
  languages: string[];
}

/** Remove a language item by `id`, searching every language in the scope file. */
export function removeItem(
  scope: ConfigScope,
  id: string,
  ctx: ConfigWriteCtx = {},
): RemoveItemResult {
  assertWritableScope(scope);
  const path = scopePath(scope, ctx);
  const doc = readScopeDoc(path);
  const languages = languagesOf(doc);
  const touched: string[] = [];
  for (const [lang, entry] of Object.entries(languages)) {
    if (!entry.items || entry.items.length === 0) continue;
    const before = entry.items.length;
    const items = entry.items.filter((i) => i.id !== id);
    if (items.length !== before) touched.push(lang);
    languages[lang] =
      items.length > 0 ? { ...entry, items } : { ...entry, items: undefined };
  }
  if (touched.length > 0) {
    doc["languages"] = languages;
    writeConfigScopeDoc(path, doc);
  }
  return { path, removed: touched.length > 0, languages: touched };
}

/** Shallow-merge into `vision` — provided fields (including arrays) replace, everything else is kept. */
export function setVision(
  scope: ConfigScope,
  vision: Partial<VisionConfig>,
  ctx: ConfigWriteCtx = {},
): string {
  assertWritableScope(scope);
  const path = scopePath(scope, ctx);
  const doc = readScopeDoc(path);
  const existing = (doc["vision"] as VisionConfig | undefined) ?? {};
  doc["vision"] = { ...existing, ...vision };
  writeConfigScopeDoc(path, doc);
  return path;
}

/** Shallow-merge into `languages[lang].voice`. */
export function setVoice(
  scope: ConfigScope,
  lang: string,
  voice: Partial<LanguageVoice>,
  ctx: ConfigWriteCtx = {},
): string {
  assertWritableScope(scope);
  const path = scopePath(scope, ctx);
  const doc = readScopeDoc(path);
  const languages = languagesOf(doc);
  const entry = languages[lang] ?? {};
  languages[lang] = { ...entry, voice: { ...(entry.voice ?? {}), ...voice } };
  doc["languages"] = languages;
  writeConfigScopeDoc(path, doc);
  return path;
}

/** Shallow-merge into `worktrees.seed`. */
export function setWorktreeSeed(
  scope: ConfigScope,
  seed: Partial<WorktreeSeed>,
  ctx: ConfigWriteCtx = {},
): string {
  assertWritableScope(scope);
  const path = scopePath(scope, ctx);
  const doc = readScopeDoc(path);
  const worktrees = (doc["worktrees"] as WorktreesConfig | undefined) ?? {};
  doc["worktrees"] = {
    ...worktrees,
    seed: { ...(worktrees.seed ?? {}), ...seed },
  };
  writeConfigScopeDoc(path, doc);
  return path;
}

/**
 * Persist a freshly-built consolidated index. Always targets WORKSPACE scope
 * (`<cwd>/.oxagen/workspace.json`) — `consolidated` is a workspace-level,
 * generated artifact (schema.ts, design.md §4/§5), never per-user or org.
 */
export function writeConsolidated(
  consolidated: ConsolidatedConfig,
  ctx: ConfigWriteCtx = {},
): string {
  const path = scopePath("workspace", ctx);
  const doc = readScopeDoc(path);
  doc["consolidated"] = consolidated;
  writeConfigScopeDoc(path, doc);
  return path;
}
