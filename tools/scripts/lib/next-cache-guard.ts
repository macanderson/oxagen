import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Turbopack persistent-cache corruption guard.
 *
 * Next 16 dev persists Turbopack's filesystem cache under `.next`. A dev
 * server killed mid-cache-write (`pnpm kill`, OOM, a crash, a stray pkill)
 * can leave that cache corrupt in a way Next does NOT detect: the persisted
 * route manifest silently loses routes, and the next `next dev` session 404s
 * pages that exist on disk (observed: every `/studio/*` page 404ing after an
 * unclean kill while warmer routes still rendered).
 *
 * The mechanism is a clean-shutdown marker INSIDE each app's `.next`: it is
 * written only when the dev launcher shuts the stack down gracefully, so a
 * cache found WITHOUT the marker was left by an unclean death and gets wiped
 * before Next boots. The cost of a false positive is one cold compile; the
 * cost of a miss is invisible 404s on real routes.
 */
export const NEXT_CACHE_APPS = ["apps/app", "apps/docs"] as const;

const MARKER_NAME = "oxagen-clean-shutdown";

export function cleanShutdownMarker(root: string, app: string): string {
  return resolve(root, app, ".next", MARKER_NAME);
}

/**
 * Boot-time check: wipe any `.next` whose previous session did not write the
 * clean-shutdown marker. Consumes the marker either way — it only vouches for
 * the one shutdown that wrote it. Returns the apps whose caches were wiped.
 */
export function guardTurbopackCaches(
  root: string,
  onWipe?: (app: string) => void,
): string[] {
  const wiped: string[] = [];
  for (const app of NEXT_CACHE_APPS) {
    const nextDir = resolve(root, app, ".next");
    if (!existsSync(nextDir)) continue;
    const marker = cleanShutdownMarker(root, app);
    if (existsSync(marker)) {
      rmSync(marker, { force: true });
      continue;
    }
    onWipe?.(app);
    rmSync(nextDir, { recursive: true, force: true });
    wiped.push(app);
  }
  return wiped;
}

/** Shutdown-time stamp: vouch for the caches of every app that has one. */
export function markCleanShutdown(root: string): void {
  for (const app of NEXT_CACHE_APPS) {
    if (!existsSync(resolve(root, app, ".next"))) continue;
    try {
      writeFileSync(cleanShutdownMarker(root, app), new Date().toISOString());
    } catch {
      // Best-effort: a missing marker just means one extra cold compile.
    }
  }
}
