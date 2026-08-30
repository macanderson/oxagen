/**
 * Postgres error classification that survives the drizzle error wrapper.
 *
 * drizzle-orm wraps every driver error in a `DrizzleQueryError` whose
 * `.cause` holds the original postgres.js error carrying the SQLSTATE `code`.
 * A naive `err.code === "23505"` therefore misses EVERY wrapped violation —
 * the friendly conflict path is skipped and the raw `Failed query: insert …`
 * SQL string leaks to the caller (a UX + information-disclosure bug).
 *
 * Walk the bounded cause chain and match the structured SQLSTATE — never the
 * locale- and driver-dependent message string.
 */

/** Postgres SQLSTATE for a unique_violation. */
const UNIQUE_VIOLATION = "23505";

interface PgLikeError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  cause?: unknown;
}

function asPgError(value: unknown): PgLikeError | undefined {
  return typeof value === "object" && value !== null
    ? (value as PgLikeError)
    : undefined;
}

/**
 * True when `err` (or any error in its `.cause` chain) is a Postgres
 * unique_violation (SQLSTATE 23505).
 *
 * @param constraint - optional unique-index name to narrow the match when more
 *   than one unique constraint is reachable from the failing statement.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    const e = asPgError(cur);
    if (!e) break;
    if (e.code === UNIQUE_VIOLATION) {
      if (!constraint) return true;
      return e.constraint_name === constraint || e.constraint === constraint;
    }
    cur = e.cause;
  }
  return false;
}
