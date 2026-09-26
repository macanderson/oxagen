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
  /** The file's exact permission bits. `open` applies the umask. This does not. */
  mode: number;
  /** Give the new file this owner. Best effort: only root may give a file away. */
  owner?: { uid: number; gid: number };
}

/**
 * Replace `path` with `data` through a sibling temp file: write, fsync,
 * chmod, rename. A reader sees the old file or the new one, never half of
 * either. A failure at any step (a full disk at `write`, an I/O error at
 * `fsync`, a refused `rename`) removes the temp file before it rethrows.
 *
 * Every atomic write in the host goes through here for that last part. The
 * temp file sits beside the target, which is often the user's own `~/.claude`
 * or `~/.codex`. A leftover `.settings.json.<pid>.<ms>.tmp` there is a file
 * nothing ever removes, and an uninstall that must leave those directories
 * byte-identical cannot (#3301). Three copies of this function cleaned up
 * only after a failed `rename`.
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
      writeAll(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
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
    // Best effort: the write already failed, and a failed cleanup must not
    // hide that error.
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone.
    }
    throw error;
  }
}

/**
 * Write every byte of `bytes` to `fd`.
 *
 * `writeSync` can take fewer bytes than it was given, on a disk that fills
 * part way through the write, and it says so only in its return value. That
 * value was ignored, so a short write was fsynced and renamed into place as
 * a truncated file. A truncated `cursor.json` or `daemon.json` then stopped
 * the daemon from starting (W-05).
 */
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0)
      throw Object.assign(
        new Error(
          `write took ${offset} of ${bytes.length} bytes and then no more`,
        ),
        { code: "EIO" },
      );
    offset += written;
  }
}

/**
 * A sensitive file (a key, a token, the host record) at mode 0600 in a
 * directory made 0700 if missing.
 */
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

/**
 * A JSON state file its owner reads at startup, read as absent when it does
 * not parse. The file is renamed to `<name>.corrupt-<ms>` beside it first,
 * so the owner starts empty and the bytes stay for incident review.
 * `onSetAside` gets the new path, or undefined when the rename failed too.
 *
 * A truncated state file used to throw here, and the daemon refused to
 * start until someone deleted the file by hand (W-05). Only the process that
 * writes the file may call this: a reader such as `tacho status` must not
 * move a file the daemon may be writing.
 */
export function readJsonStateFile(
  path: string,
  onSetAside: (movedTo: string | undefined) => void,
  now: number = Date.now(),
): unknown | undefined {
  try {
    return readJsonFileIfExists(path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    let movedTo: string | undefined = `${path}.corrupt-${now}`;
    try {
      renameSync(path, movedTo);
    } catch {
      // The next write replaces the file whole, so it is still read as
      // absent.
      movedTo = undefined;
    }
    onSetAside(movedTo);
    return undefined;
  }
}
