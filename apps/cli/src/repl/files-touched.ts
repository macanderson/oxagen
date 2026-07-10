/**
 * files-touched.ts — the session-scoped record behind the `/files` panel.
 *
 * Tracks every file the agent touches across ALL turns of a REPL session —
 * reads (read_file), creates/updates (write_file / edit_file via the engine's
 * per-edit `file-edit` events), and deletions observed after the fact (a bash
 * `rm` leaves a tracked file with git status "D", or an untracked create
 * simply missing from disk). This is deliberately different from the `/diff`
 * panel's view: `/diff` lists the working tree's CURRENT changes vs HEAD
 * (including the user's own edits), while this store answers "what did the
 * agent touch this session?" — so only tool-driven events ever record a touch.
 *
 * Everything here is pure or seam-injected (no Ink, git subprocess work stays
 * in git-diff.ts, filesystem access behind PackageResolverFs) so the reducer,
 * hydration, and package-labelling logic are unit-testable without a checkout.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import type { ChangedFile } from "./git-diff.js";

/** One CRUD letter, in the panel's display alphabet. */
export type TouchOp = "C" | "R" | "U" | "D";

/** Display order for the ops badge — always rendered as [C,R,U,D] subsets. */
const OP_ORDER: readonly TouchOp[] = ["C", "R", "U", "D"];

/** A single session-touched file, as accumulated by {@link recordTouch}. */
export interface TouchedFile {
  /** Repo-relative path (normalized — tool inputs may arrive absolute). */
  path: string;
  /** Distinct ops seen this session, kept in C,R,U,D display order. */
  ops: TouchOp[];
  /** Monotonic sequence of the FIRST touch — the panel lists in this order. */
  firstSeq: number;
}

/** A {@link TouchedFile} joined with git ground truth for display. */
export interface HydratedTouchedFile extends TouchedFile {
  /** Added lines vs HEAD (untracked creates: whole-file line count). */
  insertions?: number;
  /** Removed lines vs HEAD. */
  deletions?: number;
  /** Porcelain status char when the file currently differs from HEAD. */
  gitStatus?: string;
  /** True when git reports the file as untracked. */
  untracked: boolean;
}

/**
 * Normalize a tool-supplied path to the repo-relative form used as the store
 * key: absolute paths inside `root` become relative, `./` prefixes drop, and
 * Windows separators normalize to `/` so keys match git's output.
 */
export function normalizeTouchPath(path: string, root: string): string {
  let p = path.trim();
  if (isAbsolute(p)) {
    const rel = relative(root, p);
    // Paths outside the workspace stay absolute — still listed, never joined
    // with git data (git runs relative to root and won't know them).
    if (!rel.startsWith("..")) p = rel;
  }
  if (p.startsWith("./")) p = p.slice(2);
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Record one touch into the store (mutating `map`, the caller's ref). An op is
 * recorded at most once per file; ops keep C,R,U,D display order regardless of
 * arrival order. `seq` orders the panel chronologically by first touch.
 */
export function recordTouch(
  map: Map<string, TouchedFile>,
  rawPath: string,
  op: TouchOp,
  root: string,
  seq: number,
): void {
  const path = normalizeTouchPath(rawPath, root);
  if (path === "") return;
  const existing = map.get(path);
  if (!existing) {
    map.set(path, { path, ops: [op], firstSeq: seq });
    return;
  }
  if (!existing.ops.includes(op)) {
    existing.ops = OP_ORDER.filter((o) => o === op || existing.ops.includes(o));
  }
}

/** Seams for {@link hydrateTouchedFiles} so tests never hit a real disk. */
export interface HydrateIo {
  /** Does the (repo-relative) path exist on disk right now? */
  fileExists: (relPath: string) => boolean;
  /**
   * Line count for an untracked (newly created) file, standing in for the
   * numstat git can't produce; undefined when unreadable/binary.
   */
  countLines?: (relPath: string) => number | undefined;
}

/**
 * Join the session store with git's view of the working tree (`changed`, from
 * listChangedFiles) into display rows:
 *
 *   • +/- line counts come from numstat; untracked creates fall back to a
 *     whole-file line count (they ARE all insertions, like `git diff --no-index`).
 *   • A touched file that git now reports "D" — or that has simply vanished
 *     from disk (bash `rm` of an untracked create) — gains the D op.
 *
 * Returns rows ordered by first touch (a stable, append-at-bottom session log).
 */
export function hydrateTouchedFiles(
  entries: Iterable<TouchedFile>,
  changed: ChangedFile[],
  io: HydrateIo,
): HydratedTouchedFile[] {
  const byPath = new Map(changed.map((f) => [f.path, f]));
  const rows: HydratedTouchedFile[] = [];
  for (const entry of entries) {
    const git = byPath.get(entry.path);
    const row: HydratedTouchedFile = {
      ...entry,
      ops: [...entry.ops],
      untracked: git?.untracked ?? false,
      ...(git?.insertions !== undefined ? { insertions: git.insertions } : {}),
      ...(git?.deletions !== undefined ? { deletions: git.deletions } : {}),
      ...(git?.status !== undefined ? { gitStatus: git.status } : {}),
    };
    if (
      row.untracked &&
      row.insertions === undefined &&
      io.countLines &&
      io.fileExists(entry.path)
    ) {
      const lines = io.countLines(entry.path);
      if (lines !== undefined) {
        row.insertions = lines;
        row.deletions = 0;
      }
    }
    const deleted =
      git?.status === "D" ||
      (!git && entry.ops.some((o) => o !== "R") && !io.fileExists(entry.path));
    if (deleted && !row.ops.includes("D")) row.ops = [...row.ops, "D"];
    rows.push(row);
  }
  return rows.sort((a, b) => a.firstSeq - b.firstSeq);
}

// ── Workspace-package labelling ──────────────────────────────────────────────

/** How a touched path is captioned: `@oxagen/app: components/foo.tsx`. */
export interface PackageLabel {
  /** Workspace package name (nearest package.json `name`), if any. */
  pkg?: string;
  /** The path shown after the package name — package-relative, `src/` stripped. */
  display: string;
}

/** Filesystem seam for {@link createPackageResolver}. */
export interface PackageResolverFs {
  exists: (absPath: string) => boolean;
  /** Read a package.json and return its `name`, or undefined on any failure. */
  readPackageName: (absPath: string) => string | undefined;
}

const defaultResolverFs: PackageResolverFs = {
  exists: (p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  },
  readPackageName: (p) => {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as { name?: unknown };
      return typeof parsed.name === "string" && parsed.name !== ""
        ? parsed.name
        : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Build a memoized repo-relative-path → {@link PackageLabel} resolver for one
 * workspace root. Walks up from the file's directory to the nearest
 * `package.json` with a `name`; the repo root itself doesn't count as a
 * package (a monorepo root name would caption every stray file confusingly).
 * The path shown is relative to that package, with a leading `src/` stripped —
 * `apps/app/src/components/x.tsx` → `@oxagen/app: components/x.tsx`.
 */
export function createPackageResolver(
  root: string,
  fs: PackageResolverFs = defaultResolverFs,
): (relPath: string) => PackageLabel {
  /** dir (repo-relative, "" = root) → package name found there, or null. */
  const dirCache = new Map<string, { dir: string; pkg: string } | null>();

  const findPackage = (dir: string): { dir: string; pkg: string } | null => {
    const cached = dirCache.get(dir);
    if (cached !== undefined) return cached;
    let result: { dir: string; pkg: string } | null = null;
    if (dir !== "" && dir !== ".") {
      const manifest = `${root}/${dir}/package.json`;
      const pkg = fs.exists(manifest)
        ? fs.readPackageName(manifest)
        : undefined;
      if (pkg !== undefined) {
        result = { dir, pkg };
      } else {
        const parent = dirname(dir);
        result = findPackage(parent === "." ? "" : parent);
      }
    }
    dirCache.set(dir, result);
    return result;
  };

  return (relPath: string): PackageLabel => {
    if (isAbsolute(relPath)) return { display: relPath };
    const dir = dirname(relPath);
    const found = findPackage(dir === "." ? "" : dir);
    if (!found) return { display: relPath };
    let display = relPath.slice(found.dir.length + 1);
    if (display.startsWith("src/")) display = display.slice("src/".length);
    return { pkg: found.pkg, display };
  };
}
