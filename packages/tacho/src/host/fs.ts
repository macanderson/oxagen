/**
 * Small filesystem helpers with the semantics the host needs: sensitive
 * files are written atomically with mode 0600 (write a sibling temp file,
 * fsync, rename), so a crash mid-write never strands a truncated credential.
 */
import {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
}

export interface AtomicWriteOptions {
  /** The file's exact permission bits. `open` applies the umask; this does not. */
  mode: number;
  /** Give the new file this owner. Best effort: only root may give a file away. */
  owner?: { uid: number; gid: number };
}

/**
 * Replace `path` with `data` through a sibling temp file: write, fsync,
 * chmod, rename. A reader sees the old file or the new one, never half of
 * either, and a failure at any step (a full disk at `write`, an I/O error at
 * `fsync`, a refused `rename`) removes the temp file before it rethrows.
 *
 * That last part is why every atomic write in this package goes through here.
 * The temp file sits beside the target, so a leftover lands in the user's own
 * `~/.claude` or `~/.codex` as a `.settings.json.<pid>.<ms>.tmp` that nothing
 * ever removes, and an uninstall that is meant to leave those directories
 * byte-identical does not (#3301). Three copies of this function each got a
 * different subset of the cleanup right.
 */
export function writeFileAtomic(
  path: string,
  data: string | Buffer,
  options: AtomicWriteOptions,
): void {
  const tmp = join(
    dirname(path),
    `.${basename(path) || "file"}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(tmp, "w", options.mode);
  try {
    try {
      writeSync(
        fd,
        typeof data === "string" ? Buffer.from(data, "utf8") : data,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, options.mode);
    if (options.owner !== undefined) {
      try {
        chownSync(tmp, options.owner.uid, options.owner.gid);
      } catch {
        // Only root may give a file away. The same owner needs no change.
      }
    }
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone.
    }
    throw error;
  }
}

export function writeSensitiveFileAtomic(
  path: string,
  data: string,
  mode = 0o600,
): void {
  ensureDir(dirname(path));
  writeFileAtomic(path, data, { mode });
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonFileIfExists(path: string): unknown | undefined {
  try {
    return readJsonFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
