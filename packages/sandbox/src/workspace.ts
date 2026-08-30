// Workspace path + file-map safety for the sandboxed code-execution surface.
//
// Every capability that lands caller-supplied files into a sandbox workspace
// (agent.code.execute `files`, code.patch target paths) routes them through
// here so path-traversal confinement, count caps, and byte caps are defined
// ONCE in the lowest layer (this package) and imported by the contracts, the
// handlers, and the Docker driver alike — there is no second implementation to
// drift out of sync.
//
// This module is intentionally PURE + edge-safe: no `node:path`, no `Buffer`,
// no driver imports. That lets the contracts package (`@oxagen/oxagen`) import
// it through the `@oxagen/sandbox/workspace` subpath to validate input at the
// Zod boundary without dragging a Node runtime (or @vercel/sandbox / dockerode)
// into the app/edge bundles.

/** Absolute root every workspace-relative path resolves under inside a sandbox. */
export const WORKSPACE_ROOT = "/work";

/** Hard cap on the number of files landed into a sandbox workspace. */
export const MAX_WORKSPACE_FILES = 64;

/** Hard cap on the length of any single workspace-relative path. */
export const MAX_WORKSPACE_PATH_LENGTH = 255;

/** Hard cap on the combined UTF-8 byte size of every file in the workspace. */
export const MAX_WORKSPACE_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MiB

export class SandboxWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxWorkspaceError";
  }
}

/**
 * True when `p` is a workspace-relative path that provably cannot escape the
 * workspace root. Rejects absolute paths, Windows drive/UNC paths, backslashes,
 * NUL bytes, empty strings, over-long paths, and any `.`/`..`/empty segment.
 *
 * The check is segment-wise rather than substring-based so a legitimate name
 * like `..foo` (a file literally called "..foo") is allowed while the traversal
 * segment `..` is rejected.
 */
export function isSafeWorkspacePath(p: string): boolean {
  if (typeof p !== "string") return false;
  if (p.length === 0 || p.length > MAX_WORKSPACE_PATH_LENGTH) return false;
  // No absolute paths (POSIX or Windows), no UNC, no drive letters.
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  // Backslashes are never path separators we honour; a NUL byte truncates
  // paths in C-level filesystem calls and must never reach a driver.
  if (p.includes("\\") || p.includes("\0")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** Throw {@link SandboxWorkspaceError} when `p` is not a safe workspace path. */
export function assertSafeWorkspacePath(p: string): void {
  if (!isSafeWorkspacePath(p)) {
    throw new SandboxWorkspaceError(
      `unsafe workspace path: ${JSON.stringify(String(p)).slice(0, 120)}`,
    );
  }
}

export interface ValidateWorkspaceFilesOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
}

/**
 * Validate a `path → contents` map destined for a sandbox workspace. Throws
 * {@link SandboxWorkspaceError} on any unsafe path, non-string content, or when
 * the file-count / total-byte caps are exceeded. Returns the same map on
 * success so it composes inside a Zod `.transform`.
 */
export function validateWorkspaceFiles(
  files: Record<string, string>,
  opts: ValidateWorkspaceFilesOptions = {},
): Record<string, string> {
  const maxFiles = opts.maxFiles ?? MAX_WORKSPACE_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_WORKSPACE_TOTAL_BYTES;
  const entries = Object.entries(files);
  if (entries.length > maxFiles) {
    throw new SandboxWorkspaceError(
      `too many workspace files: ${entries.length} > ${maxFiles}`,
    );
  }
  const enc = new TextEncoder();
  let totalBytes = 0;
  for (const [path, content] of entries) {
    assertSafeWorkspacePath(path);
    if (typeof content !== "string") {
      throw new SandboxWorkspaceError(
        `workspace file "${path}" content must be a string`,
      );
    }
    totalBytes += enc.encode(content).length;
    if (totalBytes > maxTotalBytes) {
      throw new SandboxWorkspaceError(
        `workspace files exceed ${maxTotalBytes} bytes`,
      );
    }
  }
  return files;
}
