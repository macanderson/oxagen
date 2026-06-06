import { getScope } from "@oxagen/tenancy";

let unscopedCount = 0;

/** Log + count a DB access that ran with no active tenant scope. */
export function recordIfUnscoped(site: string): void {
  if (getScope() === null) {
    unscopedCount += 1;
    console.warn(`[tenancy] unscoped DB access at ${site} (db.query.unscoped=${unscopedCount})`);
  }
}

export function __unscopedCountForTests(): number {
  return unscopedCount;
}
