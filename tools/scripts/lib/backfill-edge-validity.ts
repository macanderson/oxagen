/**
 * Pure, testable core of the bi-temporal edge-validity backfill.
 *
 * The runner (`tools/scripts/backfill-edge-validity.ts`) wires these to a real
 * Neo4j driver; the logic here is driver-agnostic so it can be unit-tested with a
 * fake session. See the runner for the prod-run procedure.
 */

// The lexical guard every relationship-type write in the codebase uses. The
// type filter binds $relTypes as a Cypher parameter rather than splicing the
// value into the query text, so this is a shape check that rejects typos and
// non-conforming types early — not the thing standing between a caller and an
// injection.
export const RELATIONSHIP_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/;

/** Minimal session surface the backfill needs — satisfied by a neo4j Session. */
export interface BackfillSession {
  run: (
    cypher: string,
    params?: Record<string, unknown>,
  ) => Promise<{
    records: Array<{ get: (key: string) => unknown }>;
  }>;
}

export interface BackfillOptions {
  batchSize: number;
  dryRun: boolean;
  relTypes: string[] | null;
}

export interface BackfillResult {
  /** Edges missing recordedAt before the run. */
  remainingBefore: number;
  /** Edges stamped during the run (0 on dry-run). */
  stamped: number;
  /** Edges still missing recordedAt after the run. */
  remainingAfter: number;
}

/** Validate an optional --rel-types list; throws on a type failing the guard. */
export function validateRelTypes(relTypes: string[] | null): void {
  if (!relTypes) return;
  for (const t of relTypes) {
    if (!RELATIONSHIP_TYPE_PATTERN.test(t)) {
      throw new Error(
        `Invalid relationship type "${t}" — must match ${RELATIONSHIP_TYPE_PATTERN}`,
      );
    }
  }
}

/** Parse a comma-separated --rel-types value to an uppercased list, or null. */
export function parseRelTypes(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** WHERE type-filter fragment (empty when no --rel-types). Callers pre-validate. */
export function typeFilter(relTypes: string[] | null): string {
  if (!relTypes || relTypes.length === 0) return "";
  return " AND type(r) IN $relTypes";
}

/** Count of relationships still missing `recordedAt` (the idempotency signal). */
export function buildCountQuery(relTypes: string[] | null): string {
  return `MATCH ()-[r]->()
     WHERE r.recordedAt IS NULL${typeFilter(relTypes)}
     RETURN count(r) AS remaining`;
}

/**
 * Stamp up to $batchSize edges missing recordedAt. The `WHERE r.recordedAt IS
 * NULL` guard is what makes the whole backfill idempotent: a re-run only touches
 * still-unstamped edges. validTo / invalidatedAt are left absent (null ⇒ still
 * valid / still known).
 */
export function buildStampQuery(relTypes: string[] | null): string {
  return `MATCH ()-[r]->()
     WHERE r.recordedAt IS NULL${typeFilter(relTypes)}
     WITH r LIMIT $batchSize
     SET r.recordedAt = coalesce(r.createdAt, datetime()),
         r.validFrom  = coalesce(r.validFrom, r.createdAt, datetime())
     RETURN count(r) AS stamped`;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (
    value != null &&
    typeof value === "object" &&
    "low" in value &&
    typeof (value as { low: unknown }).low === "number"
  ) {
    return (value as { low: number }).low;
  }
  return 0;
}

async function count(
  session: BackfillSession,
  relTypes: string[] | null,
): Promise<number> {
  const res = await session.run(buildCountQuery(relTypes), { relTypes });
  return toNumber(res.records[0]?.get("remaining"));
}

/**
 * Run the batched, idempotent backfill against a session. Loops the stamp query
 * until a batch stamps 0 rows. On dry-run it only counts. `onBatch` is an
 * optional progress callback.
 */
export async function runBackfill(
  session: BackfillSession,
  opts: BackfillOptions,
  onBatch?: (stampedThisBatch: number, runningTotal: number) => void,
): Promise<BackfillResult> {
  validateRelTypes(opts.relTypes);

  const remainingBefore = await count(session, opts.relTypes);
  if (opts.dryRun || remainingBefore === 0) {
    return { remainingBefore, stamped: 0, remainingAfter: remainingBefore };
  }

  let stamped = 0;
  for (;;) {
    const res = await session.run(buildStampQuery(opts.relTypes), {
      batchSize: opts.batchSize,
      relTypes: opts.relTypes,
    });
    const n = toNumber(res.records[0]?.get("stamped"));
    if (n === 0) break;
    stamped += n;
    onBatch?.(n, stamped);
  }

  const remainingAfter = await count(session, opts.relTypes);
  return { remainingBefore, stamped, remainingAfter };
}
