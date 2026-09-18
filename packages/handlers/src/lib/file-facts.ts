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
 */

/**
 * The worktree root a batch's events agree on, or undefined.
 *
 * `worktree_path` is preferred over `project_dir` because it is the
 * checkout's own root: `project_dir` is the directory the agent was pointed
 * at, which in a monorepo is often a package rather than the repository.
 * `cwd` is deliberately not consulted. It moves within a session, and a
 * path made relative to a subdirectory is not repo-relative, it is merely
 * shorter.
 */
export function worktreeRootOf(
  contexts: readonly (
    | { worktree_path?: string; project_dir?: string }
    | undefined
  )[],
): string | undefined {
  for (const context of contexts) {
    const root = context?.worktree_path;
    if (root !== undefined && root.length > 0) return normalizeRoot(root);
  }
  for (const context of contexts) {
    const root = context?.project_dir;
    if (root !== undefined && root.length > 0) return normalizeRoot(root);
  }
  return undefined;
}

function normalizeRoot(root: string): string {
  return root.length > 1 ? root.replace(/\/+$/, "") : root;
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
 */
export function repoRelativePathOf(
  path: string,
  root: string | undefined,
): string | undefined {
  if (path.length === 0) return undefined;
  if (!path.startsWith("/")) return path;
  if (root === undefined || !root.startsWith("/")) return undefined;
  // Compare against the root plus its separator, so the boundary is checked
  // once for every root including `/`, whose separator is already there.
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) return undefined;
  const relative = path.slice(prefix.length);
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
