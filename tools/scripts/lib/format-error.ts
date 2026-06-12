/**
 * formatError — turns an unknown caught value into a human-readable string that
 * includes the full cause chain so that wrapped errors (e.g. DrizzleQueryError
 * wrapping ECONNREFUSED) surface the real root cause at a glance.
 *
 * Usage:
 *   console.error(kleur.red(formatError(err)));
 */

const MAX_CAUSE_DEPTH = 5;

/**
 * Returns the error message followed by each cause in the chain, e.g.
 *   "Failed query: insert into ... — caused by: connect ECONNREFUSED 127.0.0.1:5432"
 *
 * Non-Error values are stringified via String(). Cause chains are capped at
 * MAX_CAUSE_DEPTH levels to prevent infinite loops on cyclic causes.
 */
export function formatError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const parts: string[] = [err.message];
  let current: unknown = err.cause;
  let depth = 0;

  while (current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
    depth++;
  }

  return parts.join(" — caused by: ");
}
