/**
 * git-diff.ts — working-tree inspection for the `/diff` panel.
 *
 * Unlike git-info.ts (which reads `.git/HEAD` directly and is cheap enough to
 * call on every render), these helpers spawn real `git` subprocesses. That's
 * fine HERE because they run only on an explicit user action — opening the
 * `/diff` panel, pressing `r` to refresh, or selecting a file to view — never
 * per-render and never on a hot path. Every subprocess is wrapped so a failure
 * (not a repo, no HEAD yet, git missing) degrades to an empty list / empty diff
 * rather than throwing into the Ink render loop.
 *
 * The parsers (`parseStatusPorcelain`, `parseNumstat`) are pure and exported so
 * they're unit-testable without a git checkout, and the subprocess runner is an
 * injectable seam (`ExecFn`) so `listChangedFiles`/`getFileDiff` can be driven
 * from tests with canned output — the same philosophy as ConfigPanel's
 * `resolveOpts` test seam.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** A single changed path in the working tree, as shown in the `/diff` list. */
export interface ChangedFile {
  path: string;
  /** Single-char porcelain status to display, e.g. "M","A","D","R","C","?". */
  status: string;
  /** For renames/copies, the path the file came from. */
  renamedFrom?: string;
  /** True when git reports this as untracked ("??"). */
  untracked: boolean;
  /** Added lines vs HEAD (undefined when unknown/binary/untracked-without-numstat). */
  insertions?: number;
  /** Removed lines vs HEAD (undefined when unknown/binary). */
  deletions?: number;
}

/** Result of a subprocess run — the subset of `child_process` output we use. */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Injectable subprocess runner. The real one (below) wraps `execFile`; tests
 * pass a fake that returns canned stdout without spawning anything.
 */
export type ExecFn = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; maxBuffer?: number },
) => Promise<ExecResult>;

const execFileAsync = promisify(execFile);

/** Cap on diff output we hold in memory / render — a defensive slice, not a hard git limit. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

const defaultExec: ExecFn = async (file, args, opts) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: opts.maxBuffer ?? MAX_DIFF_BYTES * 2,
  });
  return { stdout, stderr };
};

/**
 * Combine the staged (X) and unstaged (Y) porcelain status chars into a single
 * display char. Untracked ("??") → "?"; renames/copies keep their R/C letter;
 * otherwise prefer the unstaged char when it carries a state, else the staged
 * one (so "MM" → "M", "M " → "M", " D" → "D", "R " → "R").
 */
function combineStatus(x: string, y: string): string {
  if (x === "?" && y === "?") return "?";
  if (x === "R" || y === "R") return "R";
  if (x === "C" || y === "C") return "C";
  if (y !== " ") return y;
  return x;
}

/**
 * Parse `git status --porcelain=v1 -z` output. In `-z` mode records are
 * NUL-separated (no quoting/escaping of paths), and a rename/copy entry is
 * followed by a SECOND NUL-separated field carrying its original path — the
 * field order is reversed from the human format, so the status line holds the
 * NEW path and the next token holds the OLD one. Pure — no git, no I/O.
 */
export function parseStatusPorcelain(out: string): ChangedFile[] {
  const tokens = out.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    i++;
    if (!entry) continue; // trailing empty element from the final NUL, or a blank record
    if (entry.length < 4) continue; // malformed: need "XY " + at least one path char
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3); // skip "XY" (2) + the separating space (1)
    const isRenameOrCopy = x === "R" || x === "C" || y === "R" || y === "C";
    let renamedFrom: string | undefined;
    if (isRenameOrCopy) {
      renamedFrom = tokens[i] || undefined;
      i++; // consume the paired original-path token
    }
    const untracked = x === "?" && y === "?";
    files.push({
      path,
      status: combineStatus(x, y),
      ...(renamedFrom ? { renamedFrom } : {}),
      untracked,
    });
  }
  return files;
}

/**
 * Normalize a `--numstat` path to its NEW form. Renames appear either in the
 * brace form `prefix{old => new}suffix` or the plain form `old => new`; both
 * resolve to the post-rename path so numstat counts line up with the porcelain
 * entry's `path`.
 */
function normalizeNumstatPath(raw: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (brace) {
    const [, prefix, , newMid, suffix] = brace;
    return `${prefix}${newMid}${suffix}`.replace(/\/{2,}/g, "/");
  }
  const arrow = /^(.*) => (.*)$/.exec(raw);
  if (arrow) return arrow[2]!;
  return raw;
}

/**
 * Parse `git diff --numstat HEAD` into a map of path → {insertions, deletions}.
 * Lines are `<ins>\t<del>\t<path>`; a binary file reports "-" for both counts
 * (recorded as 0). Rename paths are normalized to their new form. Pure.
 */
export function parseNumstat(
  out: string,
): Map<string, { insertions: number; deletions: number }> {
  const map = new Map<string, { insertions: number; deletions: number }>();
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const insRaw = parts[0]!;
    const delRaw = parts[1]!;
    const rawPath = parts.slice(2).join("\t");
    const insertions = insRaw === "-" ? 0 : Number.parseInt(insRaw, 10);
    const deletions = delRaw === "-" ? 0 : Number.parseInt(delRaw, 10);
    map.set(normalizeNumstatPath(rawPath), {
      insertions: Number.isNaN(insertions) ? 0 : insertions,
      deletions: Number.isNaN(deletions) ? 0 : deletions,
    });
  }
  return map;
}

/** Deterministic order: tracked changes first (alphabetical), untracked last (alphabetical). */
function sortChangedFiles(files: ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => {
    if (a.untracked !== b.untracked) return a.untracked ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}

/**
 * List the working tree's changes vs HEAD by combining porcelain status with
 * numstat line counts. Never throws: any git failure (not a repo, no HEAD)
 * yields `[]`.
 */
export async function listChangedFiles(
  root: string,
  exec: ExecFn = defaultExec,
): Promise<ChangedFile[]> {
  try {
    const status = await exec("git", ["status", "--porcelain=v1", "-z"], {
      cwd: root,
    });
    // numstat can fail independently (e.g. a repo with no commits yet has no
    // HEAD to diff against) — treat that as "no counts", not a hard failure.
    const numstat = await exec("git", ["diff", "--numstat", "HEAD"], {
      cwd: root,
    }).catch(() => ({ stdout: "", stderr: "" }) as ExecResult);
    const files = parseStatusPorcelain(status.stdout);
    const counts = parseNumstat(numstat.stdout);
    for (const file of files) {
      const c = counts.get(file.path);
      if (c) {
        file.insertions = c.insertions;
        file.deletions = c.deletions;
      }
    }
    return sortChangedFiles(files);
  } catch {
    return [];
  }
}

/** Slice an over-long diff to {@link MAX_DIFF_BYTES} with a truncation marker. */
function capDiff(text: string): string {
  if (text.length <= MAX_DIFF_BYTES) return text;
  return text.slice(0, MAX_DIFF_BYTES) + "\n… (diff truncated at 2MB)\n";
}

/**
 * Fetch a single file's unified diff. Tracked files diff against HEAD (covering
 * both staged and unstaged changes). Untracked files use `git diff --no-index`
 * against /dev/null — which EXITS 1 when the files differ, surfaced by execFile
 * as an error with the diff on `.stdout`; we treat exit-code-1-with-stdout as
 * success. Binary or empty → "" (the panel shows a "(binary or empty diff)"
 * note). Never throws.
 */
export async function getFileDiff(
  root: string,
  file: ChangedFile,
  exec: ExecFn = defaultExec,
): Promise<string> {
  try {
    if (file.untracked) {
      try {
        const { stdout } = await exec(
          "git",
          ["diff", "--no-index", "--", "/dev/null", file.path],
          {
            cwd: root,
          },
        );
        return capDiff(stdout);
      } catch (err) {
        const e = err as { code?: number | string; stdout?: string };
        if (e && e.code === 1 && typeof e.stdout === "string")
          return capDiff(e.stdout);
        return "";
      }
    }
    const { stdout } = await exec("git", ["diff", "HEAD", "--", file.path], {
      cwd: root,
    });
    return capDiff(stdout);
  } catch {
    return "";
  }
}
