/**
 * resolve.ts — Loads and merges `WorkspaceConfig` across four governed scopes.
 *
 * Precedence (lowest → highest authority; see CONFIG_SCOPE_ORDER):
 *   1. ORG       ~/.oxagen/managed.json      org-provisioned, everything implicitly locked
 *   2. USER      ~/.oxagen/user.json         personal global preferences
 *   3. WORKSPACE <cwd>/.oxagen/workspace.json  project config + web-workspace identity
 *   4. REPO      <cwd>/.oxagen/repo.json       per-repo (multi-repo workspaces only)
 *
 * This extends the merge engine in ../settings/resolve.ts (scalars: higher
 * scope wins; lists: concat+dedupe) with two changes design.md §3 calls for:
 *
 *   - Four scopes instead of three, with a GOVERNANCE layer: any leaf path
 *     can be `locked` by the scope that sets it (and every path in
 *     managed.json is *implicitly* locked). A locked value cannot be
 *     overridden by a more-specific-but-unlocked scope; when multiple locked
 *     scopes collide, ORG > USER > WORKSPACE > REPO decides.
 *   - `languages[*].items` and `sources.*` are UNIONED across scopes (keyed
 *     by `id` for items, by value for source path strings) instead of
 *     replaced — an org-mandated rule and a workspace-authored rule both
 *     survive the merge unless they collide, in which case the same
 *     locked/enforced/managed authority rule applies.
 *
 * Every other object section (vision, commands, worktrees, packageManagers,
 * vcs, issues, database) is merged recursively key-by-key — the same idea as
 * how ../settings/resolve.ts merges `env`/`mcpServers` by key, generalized to
 * arbitrary nesting depth so e.g. an org-set `vcs.branch.protected` and a
 * workspace-set `vcs.commit.convention` don't clobber each other just because
 * they both live under `vcs`. Arrays are never merged this way — only object
 * *keys* recurse; an array value (e.g. `commands.dev`) resolves as one atomic
 * leaf, same as any scalar.
 *
 * `resolveWorkspaceConfig` returns the merged config plus a provenance map
 * (dotted path → which scope won and why); `explain` reads a single path out
 * of that map in human terms, e.g. *"locked by managed.json (org)."*
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  workspaceConfigSchema,
  type WorkspaceConfig,
  type ConfigScope,
  type LanguageEntry,
  type LanguageItem,
  type LanguageVoice,
} from "./schema.js";

// ── Scope plumbing ───────────────────────────────────────────────────────────

/**
 * Authority + specificity order, lowest-authority/least-specific first.
 * Reversed, this is also "most specific wins" order (REPO > WORKSPACE > USER
 * > ORG); as-is, it is "most authoritative wins" order for locked conflicts
 * (ORG > USER > WORKSPACE > REPO) — see design.md §3.
 */
export const CONFIG_SCOPE_ORDER: readonly ConfigScope[] = [
  "org",
  "user",
  "workspace",
  "repo",
];

const SCOPE_FILE_LABEL: Record<ConfigScope, string> = {
  org: "managed.json",
  user: "user.json",
  workspace: "workspace.json",
  repo: "repo.json",
};

export interface ResolveWorkspaceConfigOptions {
  /** Override ~/.oxagen/managed.json (testing). */
  managedConfigPath?: string;
  /** Override ~/.oxagen/user.json (testing). */
  userConfigPath?: string;
  /** Skip the per-process cache (testing / after a write). */
  noCache?: boolean;
}

export interface WorkspaceConfigScopeFile {
  scope: ConfigScope;
  path: string;
  /** Present only when the file exists and parsed successfully. */
  config?: WorkspaceConfig;
  /** Present when the file exists but failed schema validation. */
  error?: string;
}

/** Why a value at a given path won over the other scopes that also set it. */
export type WinReason = "locked" | "enforced" | "managed" | "most-specific";

export interface FieldProvenance {
  scope: ConfigScope;
  /** True whenever the win was governance-driven (locked, enforced, or from managed.json). */
  locked: boolean;
  reason: WinReason;
}

export interface ResolvedWorkspaceConfig {
  /** Merged, governance-resolved config across every scope that exists. */
  config: WorkspaceConfig;
  /** Per-scope diagnostics (path, parsed body, or error) for `oxagen config`. */
  scopes: WorkspaceConfigScopeFile[];
  /** Dotted path → which scope won and why. Covers every leaf path that resolved to a value. */
  provenance: Record<string, FieldProvenance>;
}

export interface ExplainResult {
  path: string;
  /** null when the path is not set in any scope. */
  scope: ConfigScope | null;
  locked: boolean;
  reason: string;
}

/** The four scope file paths for a given workspace root, in CONFIG_SCOPE_ORDER order. */
export function getConfigScopePaths(
  cwd: string,
  opts: ResolveWorkspaceConfigOptions = {},
): Record<ConfigScope, string> {
  return {
    org: opts.managedConfigPath ?? join(homedir(), ".oxagen", "managed.json"),
    user: opts.userConfigPath ?? join(homedir(), ".oxagen", "user.json"),
    workspace: join(cwd, ".oxagen", "workspace.json"),
    repo: join(cwd, ".oxagen", "repo.json"),
  };
}

function loadConfigScope(
  scope: ConfigScope,
  path: string,
): WorkspaceConfigScopeFile {
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
  const parsed = workspaceConfigSchema.safeParse(json);
  if (!parsed.success) {
    return {
      scope,
      path,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { scope, path, config: parsed.data };
}

// ── Generic contribution resolution ─────────────────────────────────────────

interface Contribution<T> {
  scope: ConfigScope;
  value: T;
  /** Set when this contribution resists being overridden by a more specific scope. */
  authority?: WinReason;
}

/**
 * Pick the winner among the scopes that set the same value. Contributions
 * MUST be pre-filtered to CONFIG_SCOPE_ORDER order (org,user,workspace,repo)
 * — locked winners resolve to the first (most authoritative) entry, unlocked
 * winners resolve to the last (most specific) entry.
 */
function resolveContributions<T>(
  contributions: Contribution<T>[],
): { value: T; scope: ConfigScope; reason: WinReason } | undefined {
  if (contributions.length === 0) return undefined;
  const authoritative = contributions.filter((c) => c.authority !== undefined);
  if (authoritative.length > 0) {
    const winner = authoritative[0]!;
    return {
      value: winner.value,
      scope: winner.scope,
      reason: winner.authority!,
    };
  }
  const winner = contributions[contributions.length - 1]!;
  return { value: winner.value, scope: winner.scope, reason: "most-specific" };
}

/**
 * True when `scope`'s own value at `path` is locked: always true for org
 * (managed.json is implicitly locked in full), otherwise true when `path` or
 * one of its ancestor paths appears in that scope's `locked` declaration.
 */
function isPathLocked(
  scope: ConfigScope,
  path: string,
  scopeConfig: WorkspaceConfig,
): boolean {
  if (scope === "org") return true;
  const locked = scopeConfig.locked;
  if (!locked || locked.length === 0) return false;
  const lockedSet = new Set(locked);
  const segments = path.split(".");
  for (let i = segments.length; i > 0; i--) {
    if (lockedSet.has(segments.slice(0, i).join("."))) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively resolve `path`'s value across the scopes that define it.
 * Plain objects recurse key-by-key so sibling sub-paths from different
 * scopes compose instead of one scope's whole object clobbering another's.
 * Arrays and primitives are atomic leaves, resolved via resolveContributions
 * with lock-aware authority (see isPathLocked). Records a provenance entry
 * for every leaf path that resolves to a value.
 */
function mergeAtPath(
  path: string,
  contributions: { scope: ConfigScope; value: unknown }[],
  scopeConfigs: Map<ConfigScope, WorkspaceConfig>,
  provenance: Record<string, FieldProvenance>,
): unknown {
  if (contributions.length === 0) return undefined;

  if (contributions.every((c) => isPlainObject(c.value))) {
    const subKeys = new Set<string>();
    for (const c of contributions) {
      for (const k of Object.keys(c.value as Record<string, unknown>))
        subKeys.add(k);
    }
    const result: Record<string, unknown> = {};
    for (const subKey of subKeys) {
      const subContributions = contributions
        .filter(
          (c) => (c.value as Record<string, unknown>)[subKey] !== undefined,
        )
        .map((c) => ({
          scope: c.scope,
          value: (c.value as Record<string, unknown>)[subKey],
        }));
      const subResult = mergeAtPath(
        `${path}.${subKey}`,
        subContributions,
        scopeConfigs,
        provenance,
      );
      if (subResult !== undefined) result[subKey] = subResult;
    }
    return result;
  }

  const withAuthority: Contribution<unknown>[] = contributions.map((c) => {
    const scopeConfig = scopeConfigs.get(c.scope)!;
    const authority: WinReason | undefined =
      c.scope === "org"
        ? "managed"
        : isPathLocked(c.scope, path, scopeConfig)
          ? "locked"
          : undefined;
    return { scope: c.scope, value: c.value, authority };
  });
  const resolved = resolveContributions(withAuthority);
  if (resolved) {
    provenance[path] = {
      scope: resolved.scope,
      locked: resolved.reason !== "most-specific",
      reason: resolved.reason,
    };
  }
  return resolved?.value;
}

// ── languages[*].items / sources.* — accumulate by id/value ────────────────

type ValidScopeFile = WorkspaceConfigScopeFile & { config: WorkspaceConfig };

function mergeLanguages(
  valid: ValidScopeFile[],
  scopeConfigs: Map<ConfigScope, WorkspaceConfig>,
  merged: Record<string, unknown>,
  provenance: Record<string, FieldProvenance>,
): void {
  const languageNames = new Set<string>();
  for (const sf of valid) {
    for (const lang of Object.keys(sf.config.languages ?? {}))
      languageNames.add(lang);
  }
  if (languageNames.size === 0) return;

  const result: Record<string, LanguageEntry> = {};
  for (const lang of languageNames) {
    const entry: LanguageEntry = {};

    const voiceContributions: { scope: ConfigScope; value: unknown }[] = [];
    for (const sf of valid) {
      const voice = sf.config.languages?.[lang]?.voice;
      if (voice !== undefined)
        voiceContributions.push({ scope: sf.scope, value: voice });
    }
    if (voiceContributions.length > 0) {
      const voice = mergeAtPath(
        `languages.${lang}.voice`,
        voiceContributions,
        scopeConfigs,
        provenance,
      );
      if (voice !== undefined) entry.voice = voice as LanguageVoice;
    }

    const itemsById = new Map<
      string,
      { scope: ConfigScope; item: LanguageItem }[]
    >();
    for (const sf of valid) {
      for (const item of sf.config.languages?.[lang]?.items ?? []) {
        const arr = itemsById.get(item.id) ?? [];
        arr.push({ scope: sf.scope, item });
        itemsById.set(item.id, arr);
      }
    }
    if (itemsById.size > 0) {
      const items: LanguageItem[] = [];
      for (const [id, contributions] of itemsById) {
        const withAuthority: Contribution<LanguageItem>[] = contributions.map(
          (c) => ({
            scope: c.scope,
            value: c.item,
            authority: c.item.locked
              ? "locked"
              : c.item.enforced
                ? "enforced"
                : c.scope === "org"
                  ? "managed"
                  : undefined,
          }),
        );
        const resolved = resolveContributions(withAuthority);
        if (resolved) {
          items.push(resolved.value);
          provenance[`languages.${lang}.items.${id}`] = {
            scope: resolved.scope,
            locked: resolved.reason !== "most-specific",
            reason: resolved.reason,
          };
        }
      }
      entry.items = items;
    }

    if (entry.voice || entry.items) result[lang] = entry;
  }
  merged.languages = result;
}

/** Merge a string-array leaf (e.g. sources.scan) by value: union, dedupe, one provenance entry per value. */
function mergeStringListByValue(
  valid: ValidScopeFile[],
  getList: (config: WorkspaceConfig) => string[] | undefined,
  pathPrefix: string,
  provenance: Record<string, FieldProvenance>,
): string[] | undefined {
  const byValue = new Map<string, Contribution<string>[]>();
  for (const sf of valid) {
    for (const v of getList(sf.config) ?? []) {
      const arr = byValue.get(v) ?? [];
      arr.push({
        scope: sf.scope,
        value: v,
        authority: sf.scope === "org" ? "managed" : undefined,
      });
      byValue.set(v, arr);
    }
  }
  if (byValue.size === 0) return undefined;

  const result: string[] = [];
  for (const [value, contributions] of byValue) {
    const resolved = resolveContributions(contributions);
    if (resolved) {
      result.push(value);
      provenance[`${pathPrefix}.${value}`] = {
        scope: resolved.scope,
        locked: resolved.reason !== "most-specific",
        reason: resolved.reason,
      };
    }
  }
  return result;
}

const SOURCE_CATEGORIES = [
  "conventions",
  "skills",
  "agents",
  "mcp",
  "commands",
  "tools",
] as const;

function mergeSources(
  valid: ValidScopeFile[],
  merged: Record<string, unknown>,
  provenance: Record<string, FieldProvenance>,
): void {
  if (!valid.some((sf) => sf.config.sources !== undefined)) return;

  const sources: Record<string, unknown> = {};
  const scan = mergeStringListByValue(
    valid,
    (c) => c.sources?.scan,
    "sources.scan",
    provenance,
  );
  if (scan) sources.scan = scan;

  for (const scopeKey of ["workspace", "user"] as const) {
    const categories: Record<string, string[]> = {};
    for (const cat of SOURCE_CATEGORIES) {
      const list = mergeStringListByValue(
        valid,
        (c) => c.sources?.[scopeKey]?.[cat],
        `sources.${scopeKey}.${cat}`,
        provenance,
      );
      if (list) categories[cat] = list;
    }
    if (Object.keys(categories).length > 0) sources[scopeKey] = categories;
  }

  if (Object.keys(sources).length > 0) merged.sources = sources;
}

// ── Top-level merge ──────────────────────────────────────────────────────────

/** Sections merged by bespoke accumulate logic instead of the generic recursive merge. */
const ACCUMULATE_KEYS = new Set(["languages", "sources"]);

/**
 * Merge already-loaded scope files (org,user,workspace,repo order — missing
 * scopes are fine) into one WorkspaceConfig plus a provenance map. Exported
 * so tests can exercise merge semantics directly with in-memory scope
 * objects instead of writing files to disk.
 */
export function mergeWorkspaceConfigs(scopeFiles: WorkspaceConfigScopeFile[]): {
  config: WorkspaceConfig;
  provenance: Record<string, FieldProvenance>;
} {
  const provenance: Record<string, FieldProvenance> = {};
  const valid = scopeFiles.filter(
    (sf): sf is ValidScopeFile => sf.config !== undefined,
  );
  const scopeConfigs = new Map<ConfigScope, WorkspaceConfig>(
    valid.map((sf) => [sf.scope, sf.config]),
  );
  const merged: Record<string, unknown> = {};

  const topKeys = new Set<string>();
  for (const sf of valid)
    for (const k of Object.keys(sf.config)) topKeys.add(k);

  for (const key of topKeys) {
    if (key === "locked" || ACCUMULATE_KEYS.has(key)) continue;
    const contributions = valid
      .filter((sf) => (sf.config as Record<string, unknown>)[key] !== undefined)
      .map((sf) => ({
        scope: sf.scope,
        value: (sf.config as Record<string, unknown>)[key],
      }));
    const value = mergeAtPath(key, contributions, scopeConfigs, provenance);
    if (value !== undefined) merged[key] = value;
  }

  // `locked` itself is informational once merged: the union of every scope's
  // own lock declarations, so a consumer can see the full governed-path set.
  const allLocked = [...new Set(valid.flatMap((sf) => sf.config.locked ?? []))];
  if (allLocked.length > 0) merged.locked = allLocked;

  mergeLanguages(valid, scopeConfigs, merged, provenance);
  mergeSources(valid, merged, provenance);

  return { config: merged as WorkspaceConfig, provenance };
}

// ── Public API ──────────────────────────────────────────────────────────────

const cache = new Map<string, ResolvedWorkspaceConfig>();

/** Clear the per-process resolution cache (after a write, or in tests). */
export function clearWorkspaceConfigCache(): void {
  cache.clear();
}

/**
 * Resolve the effective workspace config by loading and merging every scope
 * that exists for `cwd`. Results are cached per (cwd, override paths) for
 * the life of the process; pass `noCache` to bypass (tests, or right after a
 * write to one of the scope files).
 */
export function resolveWorkspaceConfig(
  cwd: string,
  opts: ResolveWorkspaceConfigOptions = {},
): ResolvedWorkspaceConfig {
  const paths = getConfigScopePaths(cwd, opts);
  const cacheKey = `${paths.org}|${paths.user}|${paths.workspace}|${paths.repo}`;
  if (!opts.noCache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const scopes = CONFIG_SCOPE_ORDER.map((scope) =>
    loadConfigScope(scope, paths[scope]),
  );
  const { config, provenance } = mergeWorkspaceConfigs(scopes);
  const result: ResolvedWorkspaceConfig = { config, scopes, provenance };
  if (!opts.noCache) cache.set(cacheKey, result);
  return result;
}

function reasonText(scope: ConfigScope, reason: WinReason): string {
  switch (reason) {
    case "managed":
      return `locked by managed.json (org)`;
    case "locked":
      return `locked by ${SCOPE_FILE_LABEL[scope]} (${scope})`;
    case "enforced":
      return `enforced by ${SCOPE_FILE_LABEL[scope]} (${scope})`;
    case "most-specific":
      return `most specific: ${SCOPE_FILE_LABEL[scope]} (${scope})`;
  }
}

/**
 * Report which scope won for a dotted path (e.g. "packageManagers.primary",
 * "languages.typescript.items.no-any") and whether that win was governed
 * (locked/enforced/managed) or simply the most specific scope that set it.
 */
export function explain(
  cwd: string,
  path: string,
  opts: ResolveWorkspaceConfigOptions = {},
): ExplainResult {
  const { provenance } = resolveWorkspaceConfig(cwd, opts);
  const hit = provenance[path];
  if (!hit) {
    return {
      path,
      scope: null,
      locked: false,
      reason: `${path} is not set in any scope`,
    };
  }
  return {
    path,
    scope: hit.scope,
    locked: hit.locked,
    reason: reasonText(hit.scope, hit.reason),
  };
}
