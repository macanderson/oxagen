import { getScope } from "@oxagen/tenancy";
import { logger } from "./logger";

let unscopedCount = 0;

/**
 * Count a DB access that ran with no active tenant scope, and emit it as a
 * structured DEBUG line. Debug (not warn) because the overwhelming majority of
 * these are the intended pre-scope auth-resolver seams (resolveOrg /
 * resolveWorkspace / assertWorkspaceMember, session/api-key resolution) that
 * MUST run before a tenant scope exists — see withSystemDb in tenant.ts. The
 * running `count` is the operator signal for RLS-enforcement readiness; it stays
 * fully queryable via LOG_LEVEL=debug without flooding default `info` output or
 * burying real errors.
 */
export function recordIfUnscoped(site: string): void {
  if (getScope() === null) {
    unscopedCount += 1;
    logger.debug(
      { tenancy: "unscoped", site, count: unscopedCount },
      `[tenancy] unscoped DB access at ${site} (db.query.unscoped=${unscopedCount})`,
    );
  }
}

export function __unscopedCountForTests(): number {
  return unscopedCount;
}
