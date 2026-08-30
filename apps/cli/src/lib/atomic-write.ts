/**
 * atomic-write.ts — Crash/truncation-safe file writes shared by the config and
 * settings writers (`../config/write.ts`, `../settings/write.ts`).
 *
 * A plain `writeFileSync` truncates the target before the new bytes land, so a
 * process killed mid-write (or two parallel CLI sessions writing the same
 * scope file, e.g. `~/.oxagen/user.json`, at once — this repo's tree is
 * routinely worked by several parallel agent sessions) can leave a
 * zero-byte or half-written JSON file behind. Writing to a fresh temp file in
 * the SAME directory and `rename()`-ing it over the target is atomic on
 * POSIX (same filesystem, same directory) — readers only ever see the fully
 * old file or the fully new one, never a partial write.
 */
import { writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Write `data` to `path` atomically: write to `<dir>/.<pid>.<ts>.<rand>.tmp`
 * then `rename()` it over `path`. On failure, best-effort removes the temp
 * file and rethrows — the original `path` is never touched until the temp
 * write has fully succeeded.
 */
export function atomicWriteFileSync(path: string, data: string): void {
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Best-effort cleanup — the original error is what matters to the caller.
    }
    throw err;
  }
}
