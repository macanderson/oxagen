/**
 * Coerce a Neo4j count aggregate to a plain JS number.
 *
 * `count(...)` comes back over Bolt as a driver Integer — a 64-bit value with a
 * `toNumber()` — not as a JS number, so `result > 0` on the raw value is
 * comparing against an object and is always true. That is the shape of bug this
 * helper exists to remove: a count read wrongly reports success.
 *
 * Anything unrecognised, absent or non-finite coerces to 0, which is the
 * conservative direction everywhere it is used — a write whose count cannot be
 * read is treated as not having happened, so nothing is counted for it.
 */
export function countOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
