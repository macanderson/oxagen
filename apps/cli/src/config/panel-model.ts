/**
 * panel-model.ts — Pure row model behind the REPL's `/config` panel.
 *
 * Flattens a `ResolvedWorkspaceConfig` (resolve.ts) into a navigable list of
 * rows, one per resolved leaf path, each carrying the value plus its
 * provenance (which scope won and whether the win was governed). The panel
 * component (repl/config-panel.tsx) renders these rows and maps keystrokes
 * back to write.ts operations; everything here is side-effect-free so the
 * list semantics are unit-testable without a TTY.
 *
 * Three row kinds, because the resolver's provenance keys aren't all plain
 * dotted paths into the merged object:
 *   - "leaf"       ordinary scalar/array leaf — `getValueAtPath` works, and
 *                  setPath/unsetPath edit it in place.
 *   - "item"       `languages.<lang>.items.<id>` — the id is a lookup key
 *                  into an items array, not an object key; edited via
 *                  addLanguageItem / removeItem.
 *   - "list-value" `sources.*.<value>` union entries — the value IS the last
 *                  path segment; shown for visibility, edited via
 *                  `oxagen config set` (not from the panel).
 */
import type { ConfigScope, LanguageItem, WorkspaceConfig } from "./schema.js";
import type { ResolvedWorkspaceConfig, WinReason } from "./resolve.js";

export type ConfigRowKind = "leaf" | "item" | "list-value";

export interface ConfigPanelRow {
  /** Dotted path (provenance key). For "item" rows: languages.<lang>.items.<id>. */
  path: string;
  kind: ConfigRowKind;
  /** Resolved value (undefined for unset suggestions). */
  value: unknown;
  /** Compact single-line rendering of `value` for the list. */
  display: string;
  /** Scope that won resolution; null when the path is a suggestion (unset everywhere). */
  scope: ConfigScope | null;
  /** True when the win was governance-driven (locked / enforced / managed). */
  locked: boolean;
  reason: WinReason | null;
  /** For "item" rows: the language key and item id, pre-split for the writers. */
  item?: { lang: string; id: string };
}

/**
 * Paths worth surfacing even when unset, so a fresh workspace still gets a
 * useful, editable list instead of an empty panel. Order is the display
 * order of the suggestion block (after all set rows).
 */
export const SUGGESTED_PATHS: ReadonlyArray<{ path: string; hint: string }> = [
  {
    path: "vision.statement",
    hint: "one-line product vision agents anchor to",
  },
  { path: "packageManagers.primary", hint: 'e.g. "pnpm"' },
  { path: "vcs.commit.convention", hint: 'e.g. "conventional-commits"' },
  { path: "vcs.branch.convention", hint: 'e.g. "type/slug"' },
  { path: "vcs.pullRequest.base", hint: 'e.g. "main"' },
  { path: "issues.provider", hint: '"linear" or "github"' },
  { path: "worktrees.cleanup", hint: '"auto" or "manual"' },
];

/** Read a dotted path out of the merged config. Returns undefined when any hop is missing. */
export function getValueAtPath(
  config: WorkspaceConfig,
  dottedPath: string,
): unknown {
  let cur: unknown = config;
  for (const part of dottedPath.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Compact one-line value rendering. Strings stay bare; everything else is JSON. */
export function formatRowValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const ITEM_PATH = /^languages\.([^.]+)\.items\.(.+)$/;
const LIST_VALUE_PREFIX = "sources.";
/** Generated / metadata paths the panel hides — not user-editable knobs. */
const HIDDEN_PREFIXES = ["consolidated", "$schema", "version", "locked"];

function isHidden(path: string): boolean {
  return HIDDEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`));
}

function findItem(
  config: WorkspaceConfig,
  lang: string,
  id: string,
): LanguageItem | undefined {
  return config.languages?.[lang]?.items?.find((i) => i.id === id);
}

/**
 * Build the panel's row list from a resolved config: every provenance leaf
 * (sorted by path, generated/meta paths hidden), then the SUGGESTED_PATHS
 * that aren't set anywhere, as editable "(not set)" placeholders.
 */
export function buildConfigRows(
  resolved: ResolvedWorkspaceConfig,
): ConfigPanelRow[] {
  const rows: ConfigPanelRow[] = [];

  const paths = Object.keys(resolved.provenance).sort();
  for (const path of paths) {
    if (isHidden(path)) continue;
    const prov = resolved.provenance[path]!;
    const base = {
      path,
      scope: prov.scope,
      locked: prov.locked,
      reason: prov.reason,
    };

    const itemMatch = ITEM_PATH.exec(path);
    if (itemMatch) {
      const [, lang, id] = itemMatch as unknown as [string, string, string];
      const item = findItem(resolved.config, lang, id);
      const text = item?.text ?? item?.doc ?? "";
      rows.push({
        ...base,
        kind: "item",
        value: item,
        display: item ? `[${item.kind}] ${text}` : "(missing)",
        item: { lang, id },
      });
      continue;
    }

    if (path.startsWith(LIST_VALUE_PREFIX)) {
      rows.push({
        ...base,
        kind: "list-value",
        value: path.split(".").pop(),
        display: "✓",
      });
      continue;
    }

    const value = getValueAtPath(resolved.config, path);
    if (value === undefined) continue;
    rows.push({ ...base, kind: "leaf", value, display: formatRowValue(value) });
  }

  const present = new Set(rows.map((r) => r.path));
  for (const s of SUGGESTED_PATHS) {
    if (present.has(s.path)) continue;
    if (getValueAtPath(resolved.config, s.path) !== undefined) continue;
    rows.push({
      path: s.path,
      kind: "leaf",
      value: undefined,
      display: `(not set — ${s.hint})`,
      scope: null,
      locked: false,
      reason: null,
    });
  }

  return rows;
}
