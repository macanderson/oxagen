import type { ExecAsync } from "../host/service";

export const WORKTREE_PATCH_MAX_BYTES = 256 * 1024;
export const WORKTREE_UNTRACKED_MAX = 32;
const HASH = /^[a-f0-9]{40,64}$/i;

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
  const scp = /^(?:[^@\s/]+@)?([a-z0-9.-]+):([\w./-]+)$/i.exec(remote.trim());
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
