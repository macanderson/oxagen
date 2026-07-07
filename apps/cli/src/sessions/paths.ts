/**
 * Fleet store location (ADR-023) — where a project's session event logs live.
 *
 * The fleet is project-scoped: every process working the same checkout (the
 * Mission Control TUI, `oxagen fleet dispatch` from a second terminal, a jq
 * script tailing `fleet watch --json`) resolves the SAME root, which is what
 * makes cross-process aggregation work. Identity is the nearest ancestor
 * containing `.git` — a directory in a normal checkout, a file in a linked
 * worktree — so each worktree gets its own fleet (sessions edit that tree;
 * mixing worktrees in one roster would misattribute work). Outside any repo,
 * the cwd itself is the project root.
 *
 * `OXAGEN_FLEET_DIR` overrides the base for tests and sandboxes.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/** Nearest ancestor of `cwd` containing `.git` (dir or worktree file), else `cwd`. */
export function projectRoot(cwd: string): string {
  let dir = resolve(cwd);
  const stop = parse(dir).root;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === stop) return resolve(cwd);
    dir = dirname(dir);
  }
}

/** Stable 12-hex identity for a project root (realpath'd so symlinked checkouts agree). */
export function projectHash(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // Unreadable/vanished path — hash the nominal path rather than throwing;
    // the store will surface the real error on first write.
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

/** The per-project fleet root, e.g. `~/.oxagen/fleet/a1b2c3d4e5f6`. */
export function fleetRoot(cwd: string): string {
  const base =
    process.env["OXAGEN_FLEET_DIR"] && process.env["OXAGEN_FLEET_DIR"] !== ""
      ? (process.env["OXAGEN_FLEET_DIR"] as string)
      : join(homedir(), ".oxagen", "fleet");
  return join(base, projectHash(projectRoot(cwd)));
}

/** Directory holding one session's `meta.json` / `events.ndjson` / `inbox.ndjson`. */
export function sessionDir(root: string, sid: string): string {
  return join(root, "sessions", sid);
}
