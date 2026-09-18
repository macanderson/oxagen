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
  contexts: readonly ({ worktree_path?: string } | undefined)[],
): string | undefined {
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
function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** A drive-letter path (`C:/repo`) or a UNC share (`//server/share`). */
function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("//");
}

/**
 * The comparable form of an absolute path: forward slashes, and an
 * upper-case drive letter.
 *
 * The drive letter is the one case difference two hosts produce for the
 * same file (`c:/repo` and `C:/repo`), so it is folded. The rest of the
 * path is left exactly as it arrived: Windows compares filenames without
 * case but records them with it, and folding the whole path would report
 * `SRC/A.TS` and `src/a.ts` as one file on a case-sensitive host.
 */
function comparablePath(path: string): string {
  const slashes = toForwardSlashes(path);
  return /^[A-Za-z]:\//.test(slashes)
    ? `${slashes[0]?.toUpperCase() ?? ""}${slashes.slice(1)}`
    : slashes;
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
  if (path.length === 0) return undefined;
  const absolute = toForwardSlashes(path);
  if (!absolute.startsWith("/") && !isWindowsAbsolute(absolute)) return path;
  if (root === undefined) return undefined;
  const base = toForwardSlashes(root);
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
export function observedChangesOf(
  body: unknown,
): readonly ObservedChange[] {
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
