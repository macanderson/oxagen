import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecAsync } from "../host/service";
import type { MeasuredPaths } from "./session-changes";

export const WORKTREE_PATCH_MAX_BYTES = 256 * 1024;
export const WORKTREE_UNTRACKED_MAX = 32;
const HASH = /^[a-f0-9]{40,64}$/i;
/** Changed paths whose size and times join the fingerprint; past this, status alone is compared. */
export const WORKTREE_FINGERPRINT_STAT_MAX = 512;

export interface WorktreeSnapshot {
  version: 1;
  root: string;
  repository: string | null;
  baseline: string | null;
  head: string | null;
  patch: string;
  complete: boolean;
  limitations: string[];
  /**
   * On the session basis, what the hunks in `patch` were taken against
   * (ADR-188 decision 5). The paths in `baseline_paths` against `baseline`,
   * the paths in `pre_session_paths` against what they held at the session's
   * first read, and every other path against `head_ref`, or against nothing
   * when untracked. Absent on a snapshot of every change since `baseline`.
   */
  bases?: {
    head_ref: string;
    baseline_paths: string[];
    pre_session_paths: string[];
  };
}

/** A path as git prints it in a patch header, quoted when git would quote it. */
function headerPath(prefix: string, path: string): string {
  const name = `${prefix}${path}`;
  // Git quotes a name holding a control byte, a quote, or a backslash, even
  // with `core.quotePath=false`.
  let quoted = false;
  let out = "";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (code < 0x20 || code === 0x7f)
      out += `\\${code.toString(8).padStart(3, "0")}`;
    else {
      out += ch;
      continue;
    }
    quoted = true;
  }
  return quoted ? `"${out}"` : name;
}

/**
 * A `git diff --no-index` patch from a pre-session copy, with its header
 * naming the repo-relative path on both sides. Git names the copy by its
 * path in Tacho's state directory, which would put that directory into the
 * record. The hunks are left as git wrote them.
 */
export function relabelPreSessionPatch(
  patch: string,
  path: string,
  sides: { before: boolean; after: boolean },
): string {
  if (patch.length === 0) return patch;
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex(
    (line) =>
      line.startsWith("@@") ||
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch"),
  );
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  const body = firstHunk === -1 ? [] : lines.slice(firstHunk);
  const before = sides.before ? headerPath("a/", path) : "/dev/null";
  const after = sides.after ? headerPath("b/", path) : "/dev/null";
  const out = [
    `diff --git ${headerPath("a/", path)} ${headerPath("b/", path)}`,
  ];
  for (const line of header) {
    if (line.startsWith("--- ")) out.push(`--- ${before}`);
    else if (line.startsWith("+++ ")) out.push(`+++ ${after}`);
    else if (
      /^(?:index |new file mode |deleted file mode |old mode |new mode )/.test(
        line,
      )
    )
      out.push(line);
  }
  if (body[0]?.startsWith("Binary files "))
    body[0] = `Binary files ${before} and ${after} differ`;
  return [...out, ...body].join("\n");
}

/** Keep only a forge host and repository path. Never retain remote credentials. */
export function safeRepositoryUrl(remote: string): string | null {
  // A URL with a scheme is never scp syntax. Without this guard the scp
  // pattern read `https://github.com/acme/repo.git` as host `https` and path
  // `//github.com/...`, and every credential-free HTTPS remote recorded no
  // repository (#4010).
  const scp = remote.includes("://")
    ? null
    : /^(?:[^@\s/]+@)?([a-z0-9.-]+):([\w./-]+)$/i.exec(remote.trim());
  try {
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : remote.trim());
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol))
      return null;
    if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes("."))
      return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (
      !/^[\w.-]+(?:\/[\w.-]+)+$/.test(path) ||
      path.split("/").some((p) => p === "." || p === "..")
    )
      return null;
    return `https://${url.hostname.toLowerCase()}/${path}`;
  } catch {
    return null;
  }
}

/** The path of one `git status --porcelain=v2 -z` record, or null for a record with none. */
function statusPath(record: string): string | null {
  // Ordinary changes carry 8 fields before the path, unmerged ones 10, and
  // untracked or ignored entries only their marker (`--no-renames` rules out
  // the rename record and its second path).
  const fields = record.startsWith("1 ")
    ? 8
    : record.startsWith("u ")
      ? 10
      : record.startsWith("? ") || record.startsWith("! ")
        ? 1
        : null;
  if (fields === null) return null;
  const parts = record.split(" ");
  return parts.length > fields ? parts.slice(fields).join(" ") : null;
}

/**
 * The worktree state a capture reads: every changed and untracked path, with
 * the size and change times of each. `git status` alone misses a second edit
 * to a file that was already modified, so the file times carry that. A
 * missing file stats as absent, which is itself state.
 */
async function worktreeFingerprint(
  status: string | undefined,
  root: string,
): Promise<string | undefined> {
  if (status === undefined) return undefined;
  const records = status.split("\0").filter(Boolean);
  const stats = await Promise.all(
    records.slice(0, WORKTREE_FINGERPRINT_STAT_MAX).map(async (record) => {
      const path = statusPath(record);
      if (path === null) return "";
      try {
        const info = await lstat(join(root, path));
        return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch {
        return "absent";
      }
    }),
  );
  return JSON.stringify([records, stats]);
}

/**
 * Snapshot bytes describe the observed tree against `baseline`.
 *
 * `measured`, when given, is what the reconciliation beside this snapshot
 * reported and what it measured each path against (`readSessionChanges`).
 * The patch then covers those paths and no others, and takes each against
 * the same state its row was counted from: a path the session committed
 * against the baseline, a file that already held edits against its
 * pre-session copy (#3384), and any other against the `HEAD` the
 * reconciliation read. Taking every path against the baseline put a pulled
 * hunk into the patch of a file the session then edited, beside a row that
 * counted only the session's edit (#4320). Without `measured`, as for a
 * session measured the old way, the patch holds every change since the
 * baseline, including changes present before the run.
 */
export async function readWorktreeSnapshot(
  exec: ExecAsync,
  cwd: string,
  baseline?: string,
  measured?: MeasuredPaths,
): Promise<WorktreeSnapshot | undefined> {
  let directory = cwd;
  const read = async (
    args: string[],
    statuses = [0],
  ): Promise<string | undefined> => {
    try {
      const result = await exec("git", [
        "-C",
        directory,
        "--no-optional-locks",
        "-c",
        "core.quotePath=false",
        ...args,
      ]);
      return result.status !== null && statuses.includes(result.status)
        ? result.stdout
        : undefined;
    } catch {
      return undefined;
    }
  };
  const root = (await read(["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) return undefined;
  directory = root;
  const readStatus = () =>
    read([
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]);
  const stateBefore = await worktreeFingerprint(await readStatus(), root);
  const [headRaw, remote, untracked] = await Promise.all([
    read(["rev-parse", "HEAD"]),
    read(["remote", "get-url", "origin"]),
    read(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const head = headRaw?.trim();
  const base =
    baseline && HASH.test(baseline)
      ? baseline
      : head && HASH.test(head)
        ? head
        : null;
  const limitations: string[] = [];
  let patch = "";
  let remaining = WORKTREE_PATCH_MAX_BYTES;
  const append = (value: string | undefined) => {
    if (value === undefined) {
      limitations.push("diff_read_failed");
      return;
    }
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > remaining) limitations.push("patch_size_limit");
    patch += bytes.subarray(0, remaining).toString("utf8");
    remaining = Math.max(0, remaining - bytes.length);
  };
  // Disable external diff programs and textconv from repository configuration.
  const trackedDiff = (ref: string, paths?: readonly string[]) =>
    read([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ref,
      "--",
      // `:(literal)`, so a path holding `*` or `?` names itself.
      ...(paths ?? []).map((path) => `:(literal)${path}`),
    ]);
  // The untracked paths the patch covers. All of them without `measured`.
  let fromNothing: ReadonlySet<string> | undefined;
  if (measured === undefined) {
    if (!base) limitations.push("baseline_not_recorded");
    else append(await trackedDiff(base));
  } else {
    if (measured.fromBaseline.length > 0) {
      if (!baseline || !HASH.test(baseline))
        limitations.push("baseline_not_recorded");
      else append(await trackedDiff(baseline, measured.fromBaseline));
    }
    // A path measured against HEAD is tracked or untracked. The tracked diff
    // prints nothing for an untracked one, which the loop below takes.
    if (measured.fromHead.length > 0) {
      if (!HASH.test(measured.headRef)) limitations.push("diff_read_failed");
      else append(await trackedDiff(measured.headRef, measured.fromHead));
    }
    // Each against what it held at the session's first read, as its row
    // was counted: the copy, or nothing for a path that was absent then.
    for (const { path, copy } of measured.fromPreSession) {
      let present: boolean;
      try {
        present = (await lstat(join(root, path))).isFile();
      } catch {
        present = false;
      }
      if (copy === null && !present) continue;
      const raw = await read(
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--",
          copy ?? "/dev/null",
          present ? path : "/dev/null",
        ],
        [0, 1],
      );
      append(
        raw === undefined
          ? undefined
          : relabelPreSessionPatch(raw, path, {
              before: copy !== null,
              after: present,
            }),
      );
    }
    // The rows were counted against the HEAD the reconciliation read. A
    // commit since then moved the tree those counts describe.
    if (head !== undefined && HASH.test(head) && head !== measured.headRef)
      limitations.push("head_changed_during_capture");
    fromNothing = new Set(measured.fromHead);
  }
  const untrackedPaths = (untracked?.split("\0").filter(Boolean) ?? []).filter(
    (path) => fromNothing === undefined || fromNothing.has(path),
  );
  if (untracked === undefined) limitations.push("untracked_read_failed");
  if (untrackedPaths.length > WORKTREE_UNTRACKED_MAX)
    limitations.push("untracked_file_limit");
  for (const path of untrackedPaths.slice(0, WORKTREE_UNTRACKED_MAX)) {
    if (remaining === 0) {
      limitations.push("untracked_content_omitted");
      break;
    }
    append(
      await read(
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-index",
          "--",
          "/dev/null",
          path,
        ],
        [0, 1],
      ),
    );
  }
  const headAfter = (await read(["rev-parse", "HEAD"]))?.trim();
  if (headAfter !== head) limitations.push("head_changed_during_capture");
  // The patch is several reads, so an edit between them (a formatter, a
  // concurrent subagent) can splice two worktree states into one patch.
  const stateAfter = await worktreeFingerprint(await readStatus(), root);
  if (stateBefore === undefined || stateAfter === undefined)
    limitations.push("worktree_state_unverified");
  else if (stateAfter !== stateBefore)
    limitations.push("worktree_changed_during_capture");
  if (patch.includes("Binary files "))
    limitations.push("binary_content_not_captured");
  return {
    version: 1,
    root,
    repository: remote ? safeRepositoryUrl(remote) : null,
    baseline: base,
    head: head && HASH.test(head) ? head : null,
    patch,
    complete: limitations.length === 0,
    limitations: [...new Set(limitations)],
    ...(measured === undefined
      ? {}
      : {
          bases: {
            head_ref: measured.headRef,
            baseline_paths: [...measured.fromBaseline],
            pre_session_paths: measured.fromPreSession.map(
              (entry) => entry.path,
            ),
          },
        }),
  };
}
