/**
 * Small filesystem helpers with the semantics the host needs: sensitive
 * files are written atomically with mode 0600 (write a sibling temp file,
 * fsync, rename), so a crash mid-write never strands a truncated credential.
 */
import {
  closeSync,
  existsSync,
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

export function writeSensitiveFileAtomic(
  path: string,
  data: string,
  mode = 0o600,
): void {
  ensureDir(dirname(path));
  const tmp = join(
    dirname(path),
    `.${basename(path) || "file"}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    const fd = openSync(tmp, "w", mode);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    // A write, fsync, or rename that fails leaves the sibling temp file
    // behind — holding a sensitive payload nothing will ever pick up — and,
    // on a directory this function is called against repeatedly (`cursor.json`,
    // `state.json`), a growing pile of them. Best effort: the write already
    // failed, and a failed cleanup must not hide that error.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* the write's own error is the one that matters */
    }
    throw error;
  }
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
