/**
 * Two facts about a touched path that the record already contains and has
 * never written down: where the file sits inside its repository, and what
 * language it is.
 *
 * `tacho.session_files` has carried `repo_relative_path` and `language`
 * since the table was created, and nothing has ever filled them. Both are
 * derivable at ingest from what every frame already ships, so neither needs
 * a new producer, a new body member, or a round trip to the host.
 *
 * Why they are worth filling. An absolute path is the operator's machine,
 * not the work: `/Users/mac/src/oxagen/packages/tacho/src/envelope.ts` and
 * `/home/runner/work/oxagen/packages/tacho/src/envelope.ts` are the same
 * file edited on two hosts, and a run record that cannot see that cannot
 * group, compare or attribute them. The repo-relative form is the one that
 * is stable across hosts, so it is the one a Run page shows and the one the
 * Neo4j lineage seam joins on. Language is the cheapest useful axis over a
 * set of changed files, and it is what turns "41 files" into something a
 * reviewer can triage.
 *
 * Both are best-effort and both may be null. A path outside the worktree, a
 * session with no worktree context, and an extension this module does not
 * know all return undefined rather than a guess, because a wrong language
 * on a run record is worse than an absent one.
 *
 * The file also holds the reader for the observed side of the same
 * question. `repo_relative_path` and `language` are derived from an
 * attested path; `observedChangesOf` unpacks what the collector read off
 * the worktree with git, which is where `lines_added` and `lines_removed`
 * come from.
 */
import type { ObservedChange } from "@oxagen/tacho";

/**
 * The worktree root a batch's events agree on, or undefined.
 *
 * `worktree_path` is the only field read, because it is the only one that
 * is the checkout's own root. `project_dir` is the directory the agent was
 * pointed at, which in a monorepo is usually a package: stripping
 * `/repo/packages/tacho` off `/repo/packages/tacho/src/x.ts` leaves
 * `src/x.ts`, which every other package in the tree also has. Two different
 * files would then carry one repository identity on the Run page and in the
 * lineage join, which is the opposite of what this column is for, so a
 * batch that names no worktree leaves the field null instead. `cwd` is not
 * consulted either, and for the same reason plus one more: it moves within
 * a session.
 *
 * This is the attested fallback. Where a reconciliation frame observed the
 * path, its own `repo_relative_path` wins, because git answered with
 * `rev-parse --show-toplevel` rather than inferring a root.
 */
export function worktreeRootOf(
  contexts: readonly (
    | { worktree_path?: string; project_dir?: string }
    | undefined
  )[],
): string | undefined {
  // `project_dir` is in the parameter type and is deliberately never read.
  // Naming it keeps the choice visible at the signature: a reader asking
  // whether the field was overlooked finds the answer here.
  for (const context of contexts) {
    const root = context?.worktree_path;
    if (root !== undefined && root.length > 0) return normalizeRoot(root);
  }
  return undefined;
}

function normalizeRoot(root: string): string {
  const slashes = toForwardSlashes(root);
  return slashes.length > 1 ? slashes.replace(/\/+$/, "") : slashes;
}

/**
 * A Windows path in the one separator the rest of this module compares on.
 *
 * `win32` is a supported host (`tachoPlatformSchema`), so its paths reach
 * this module verbatim, separators and all. Comparing them without this
 * makes every Windows path look relative.
 */
function toForwardSlashes(path: string, root?: string): string {
  // A backslash is a legal POSIX filename character. Normalize separators
  // only when the path or its recorded root identifies Windows.
  const windows =
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//") ||
    (root !== undefined &&
      (/^[A-Za-z]:[\\/]/.test(root) ||
        root.startsWith("\\\\") ||
        root.startsWith("//")));
  return windows ? path.replace(/\\/g, "/") : path;
}

/** A drive-letter path (`C:/repo`) or a UNC share (`//server/share`). */
function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("//");
}

/**
 * `path` with its `.` and `..` segments resolved, on forward slashes.
 *
 * A tool is free to report `/repo/../shared/config.ts`, and without this the
 * containment test below sees a string that starts with `/repo/` and hands
 * back `../shared/config.ts` — a file that resolves outside the checkout,
 * recorded as if it belonged to this repository and liable to collide with a
 * genuine relative path in the same column. Resolving the segments first
 * makes the path say where it actually is before anything is measured.
 *
 * The resolution is lexical, never a filesystem read: `path.resolve` answers
 * for the host this process runs on, and these paths come off other machines,
 * including `win32` ones this module is required to read on POSIX. A symlink
 * can still make a lexically contained path resolve elsewhere, which is the
 * host's business and not something an ingest-time string can settle.
 *
 * Leading slashes are kept, because they carry meaning: one is a POSIX root,
 * two are a UNC share. `..` that climbs above an absolute root is dropped, as
 * POSIX does; on a relative path it is kept, so the caller can see the escape.
 */
function normalizeDotSegments(path: string): string {
  const leading = /^\/+/.exec(path)?.[0] ?? "";
  const root = leading.length >= 2 ? "//" : leading;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      const last = segments[segments.length - 1];
      // A drive letter is a root of its own, so `..` stops at it rather than
      // popping it and turning `C:/../repo/x.ts` into a relative path.
      if (last !== undefined && /^[A-Za-z]:$/.test(last)) continue;
      if (last !== undefined && last !== "..") segments.pop();
      else if (root.length === 0) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  return `${root}${segments.join("/")}`;
}

/**
 * The comparable form of a path: forward slashes, and case folded on the
 * hosts that do not distinguish it.
 *
 * A Windows path is folded whole. NTFS compares filenames without case but
 * records them with it, so one tool reporting `c:/Repo/src/a.ts` and a git
 * read reporting the root as `C:/repo` are naming the same directory, and
 * folding only the drive letter left the prefix test failing on everything
 * below it — the same file landing in two rows, which is what this column
 * exists to prevent. The recorded spelling is unaffected: the relative part
 * is sliced out of the original, and folding changes no length.
 *
 * A POSIX path is left exactly as it arrived, because there the case is
 * part of the name: `SRC/A.TS` and `src/a.ts` are two files on ext4, and
 * folding would report them as one.
 */
function comparablePath(path: string): string {
  const slashes = toForwardSlashes(path);
  return isWindowsAbsolute(slashes) ? slashes.toLowerCase() : slashes;
}

/**
 * The part of `path` below `root`, or undefined when the path does not sit
 * under it.
 *
 * The boundary is checked on a separator rather than on the prefix alone,
 * so `/src/oxagen-brand/x.ts` is not reported as living inside
 * `/src/oxagen`. A path equal to the root is not a file and returns
 * undefined. A path that is already relative is returned as it stands,
 * since a relative path in the record is relative to the worktree already.
 *
 * `.` and `..` are resolved before the boundary is tested, so a path such as
 * `/repo/../shared/config.ts` is measured as `/shared/config.ts` and refused
 * rather than recorded as `../shared/config.ts` inside this repository.
 *
 * Absolute means absolute on any supported host, not just a leading slash.
 * `C:\\repo\\src\\a.ts` and `\\\\server\\share\\src\\a.ts` are absolute on
 * `win32`, which `tachoPlatformSchema` allows, and reading either as
 * already-relative would store one machine's drive letter in the one field
 * that is supposed to read the same on every machine. Both are normalized
 * to forward slashes and then measured against the root exactly as a POSIX
 * path is. A path with no root to measure against still returns undefined
 * rather than the whole thing.
 */
export function repoRelativePathOf(
  path: string,
  root: string | undefined,
): string | undefined {
  if (path.length === 0 || root === undefined) return undefined;
  // Dot segments are resolved before anything is measured, so a path that
  // climbs out of the worktree says so instead of passing the prefix test.
  const absolute = normalizeDotSegments(toForwardSlashes(path, root));
  if (absolute.length === 0) return undefined;
  // An already relative path is returned normalized, not as it arrived. A
  // tool on Windows reports `src\\a.ts` for the file a POSIX host calls
  // `src/a.ts`, and returning the first unchanged would store two keys for
  // one file in the column whose whole purpose is to read the same on every
  // machine. One that still climbs after normalization names a file above
  // the worktree, which this column cannot describe, so it returns undefined
  // rather than a key that would collide with a path inside the checkout.
  if (!absolute.startsWith("/") && !isWindowsAbsolute(absolute)) {
    if (absolute === ".." || absolute.startsWith("../")) return undefined;
    return absolute;
  }
  const base = normalizeDotSegments(toForwardSlashes(root));
  if (!base.startsWith("/") && !isWindowsAbsolute(base)) return undefined;
  // Compare against the root plus its separator, so the boundary is checked
  // once for every root including `/`, whose separator is already there.
  const comparable = comparablePath(absolute);
  const comparableRoot = comparablePath(base);
  const prefix = comparableRoot.endsWith("/")
    ? comparableRoot
    : `${comparableRoot}/`;
  if (!comparable.startsWith(prefix)) return undefined;
  const relative = absolute.slice(prefix.length);
  return relative.length === 0 ? undefined : relative;
}

/**
 * Extensions this module is willing to name a language for.
 *
 * The list is short on purpose. It covers what the agents Oxagen records
 * actually edit, and every addition is a claim the run record will repeat,
 * so an extension nobody has seen is left out rather than guessed at.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  css: "css",
  scss: "css",
  html: "html",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "markdown",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  tf: "terraform",
};

/**
 * Filenames that name a language on their own, having no extension to read.
 */
const LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gemfile: "ruby",
  rakefile: "ruby",
};

/**
 * The language of a path, from its extension or its filename.
 *
 * A dotfile such as `.gitignore` has no extension: the leading dot is part
 * of the name, so it is read as a filename and found only if it is listed.
 */
export function languageOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.length === 0) return undefined;
  const named = LANGUAGE_BY_FILENAME[base.toLowerCase()];
  if (named !== undefined) return named;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
}

/**
 * The frame kind that carries what git observed, as opposed to what a tool
 * announced. Spelled once here so the ingest rollup and its tests agree.
 */
export const WORKTREE_RECONCILED_KIND = "oxagen:worktree_reconciled";

/**
 * The observed change list of a reconciliation frame's body.
 *
 * The contract already validated the body against the frame's schema, so
 * this is a narrowing rather than a parse. It stays defensive anyway: a row
 * of the wrong shape is skipped rather than written as a partial record,
 * because a file fact nobody can trust is worse than a missing one.
 */
export function observedChangesOf(body: unknown): readonly ObservedChange[] {
  const changes = (body as { observed_changes?: unknown } | undefined)
    ?.observed_changes;
  if (!Array.isArray(changes)) return [];
  const out: ObservedChange[] = [];
  for (const change of changes) {
    const row = change as Partial<ObservedChange> | undefined;
    if (
      row === undefined ||
      typeof row.path !== "string" ||
      row.path.length === 0 ||
      typeof row.status !== "string" ||
      typeof row.lines_added !== "number" ||
      typeof row.lines_removed !== "number"
    )
      continue;
    out.push({
      path: row.path,
      repo_relative_path:
        typeof row.repo_relative_path === "string"
          ? row.repo_relative_path
          : "",
      status: row.status,
      lines_added: row.lines_added,
      lines_removed: row.lines_removed,
    });
  }
  return out;
}

/** One file key across batches, qualified by the worktree that was recorded. */
export function fileIdentityOf(
  path: string,
  root?: string,
): {
  key: string;
  path: string;
  repoRelativePath?: string;
} {
  const normalized = normalizeDotSegments(toForwardSlashes(path, root));
  const relative = repoRelativePathOf(normalized, root);
  const absolute = normalized.startsWith("/") || isWindowsAbsolute(normalized);
  const placed =
    !absolute && root !== undefined && relative !== undefined
      ? normalizeDotSegments(`${normalizeRoot(root)}/${relative}`)
      : normalized;
  return {
    key: `${placed.startsWith("/") || isWindowsAbsolute(placed) ? "absolute" : "unplaced"}:${comparablePath(placed)}`,
    path: placed,
    ...(relative === undefined ? {} : { repoRelativePath: relative }),
  };
}
