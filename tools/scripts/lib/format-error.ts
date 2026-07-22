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
 *
 * AggregateError special case: Node's own multi-address TCP connect failure
 * (e.g. `postgres` / any driver hitting a refused localhost connection) throws
 * an AggregateError whose top-level `.message` is EMPTY BY DESIGN — the real
 * detail (ECONNREFUSED, the code, the address) lives in `.errors[]`, one per
 * attempted address. Reading only `.message` here silently produces an empty
 * string, which is worse than no error handling at all (a red "" tells the
 * operator nothing). When `.message` is empty and `.errors` is a non-empty
 * array, fall back to the first sub-error's message/code instead.
 */
export function formatError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const parts: string[] = [describeError(err)];
  let current: unknown = err.cause;
  let depth = 0;

  while (current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH) {
    if (current instanceof Error) {
      parts.push(describeError(current));
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
    depth++;
  }

  return parts.join(" — caused by: ");
}

/**
 * Single-error → string, with the AggregateError empty-message fallback.
 * `errors` isn't in the base `Error` typing, so read it defensively.
 */
function describeError(err: Error): string {
  if (err.message) return err.message;

  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const [first] = errors;
    if (first instanceof Error) {
      const code = (first as { code?: unknown }).code;
      const codeSuffix = typeof code === "string" ? ` [${code}]` : "";
      return `${err.name || "AggregateError"}: ${first.message}${codeSuffix}`;
    }
    return `${err.name || "AggregateError"}: ${String(first)}`;
  }

  return err.name || "Error";
}
