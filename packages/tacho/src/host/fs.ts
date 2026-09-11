/**
 * Small filesystem helpers with the semantics the host needs: sensitive
 * files are written atomically with mode 0600 (write a sibling temp file,
 * fsync, rename), so a crash mid-write never strands a truncated credential.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
    `.${path.split("/").pop() ?? "file"}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
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
