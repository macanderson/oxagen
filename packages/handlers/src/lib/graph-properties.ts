import { logger } from "../logger";

/**
 * Shared tolerant decoder for the `GraphNode.properties` column.
 *
 * Nodes store their property bag as a JSON string, but real-world data drifts:
 * an ingestion bug can write invalid/double-encoded JSON, and some driver
 * paths return the value as a native Neo4j map object instead of a string.
 * Decoding must never throw: a single bad blob would otherwise reject the
 * whole handler and 500 the entire graph-explorer page over one corrupt node.
 * A property bag we cannot read degrades to `{}` (with a warning) and the
 * node still renders by its label/displayName.
 */
export function safeParseProperties(
  raw: unknown,
  context: { nodeId?: string } = {},
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};

  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn(
        { nodeId: context.nodeId },
        "graph properties: malformed JSON blob; substituting empty bag",
      );
      return {};
    }
    if (!isPlainObject(parsed)) {
      // Valid JSON but not an object (a scalar, array, or double-encoded
      // string) — callers require a Record, so degrade to empty.
      logger.warn(
        { nodeId: context.nodeId },
        "graph properties: JSON blob is not an object; substituting empty bag",
      );
      return {};
    }
    return normalizeDriverIntegers(parsed);
  }

  if (isPlainObject(raw)) {
    // Native map straight from the driver — pass it through.
    return normalizeDriverIntegers(raw);
  }

  logger.warn(
    { nodeId: context.nodeId, valueType: typeof raw },
    "graph properties: unsupported value type; substituting empty bag",
  );
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shallow pass converting Neo4j Integer-like `{low, high}` values to plain JS
 * numbers, the same normalisation graph.node.list applies to its count
 * aggregate. Only the exact two-key driver shape is converted; any other object
 * is left untouched.
 *
 * A driver Integer is a 64-bit value split into two 32-bit halves, so both
 * halves have to be recombined — reading `low` alone silently reports 0 for
 * 2^32, and a wrong number for every value that does not fit in 32 bits.
 * Magnitudes above Number.MAX_SAFE_INTEGER still lose precision; that is
 * inherent to handing a JS number back and matches the driver's own toNumber().
 */
function normalizeDriverIntegers(
  bag: Record<string, unknown>,
): Record<string, unknown> {
  let needsCopy = false;
  for (const value of Object.values(bag)) {
    if (isDriverInteger(value)) {
      needsCopy = true;
      break;
    }
  }
  if (!needsCopy) return bag;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    out[key] = isDriverInteger(value) ? driverIntegerToNumber(value) : value;
  }
  return out;
}

/** Recombine a driver Integer's two 32-bit halves into one JS number. */
function driverIntegerToNumber(value: { low: number; high: number }): number {
  return value.high * 2 ** 32 + (value.low >>> 0);
}

function isDriverInteger(
  value: unknown,
): value is { low: number; high: number } {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 2 &&
    typeof value.low === "number" &&
    typeof value.high === "number"
  );
}
