import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecAsync } from "../host/service";

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

/** Snapshot bytes describe the observed tree, including changes present before the run. */
export async function readWorktreeSnapshot(
  exec: ExecAsync,
  cwd: string,
  baseline?: string,
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
  if (base)
    append(
      await read([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        base,
        "--",
      ]),
    );
  else limitations.push("baseline_not_recorded");
  const paths = untracked?.split("\0").filter(Boolean) ?? [];
  if (untracked === undefined) limitations.push("untracked_read_failed");
  if (paths.length > WORKTREE_UNTRACKED_MAX)
    limitations.push("untracked_file_limit");
  for (const path of paths.slice(0, WORKTREE_UNTRACKED_MAX)) {
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
  };
}
