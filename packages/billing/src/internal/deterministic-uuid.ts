import { createHash } from "node:crypto";

/**
 * Derive a deterministic UUID from any external provider id (e.g. `ch_xxx`,
 * `dp_xxx`, `pm_xxx`) so the value fits a `uuid`-typed column and can key
 * a partial-unique idempotency index.
 *
 * The output is NOT a standards-compliant v4/v5 UUID — it is a hex-derived
 * hyphen-separated string that is stable for a given seed and guaranteed to
 * fit the `uuid` Postgres type (32 hex chars split 8-4-4-4-12).
 */
export function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
