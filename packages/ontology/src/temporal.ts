/**
 * temporal.ts — bi-temporal fact validity for knowledge-graph relationships.
 *
 * Every fact-bearing edge carries two independent time axes so the graph can
 * answer "what was true, and what did we know, as of any point in time":
 *
 *   VALID TIME — when the fact is true in the world:
 *     • validFrom      datetime           observed / event time (falls back to now)
 *     • validTo        datetime | null    null ⇒ still true in the world
 *
 *   TRANSACTION TIME — when we learned / recorded it:
 *     • recordedAt     datetime           when this assertion was written
 *     • invalidatedAt  datetime | null    null ⇒ never retracted / superseded
 *
 * Supersession never deletes or overwrites: when a new fact contradicts an
 * existing one (same subject + predicate, different object) the prior edge is
 * *closed* by stamping `validTo` / `invalidatedAt`, preserving full history.
 *
 * The Cypher here is composed as string fragments interpolated into the existing
 * MERGE / MATCH statements in the write and read handlers. The only interpolated
 * text is identifiers — a relationship *variable name* and a column-alias
 * *prefix* — and both are checked against a plain-identifier grammar before they
 * reach a query string. Every time value is passed as a bound `$param`, never
 * concatenated.
 */

/** The four bi-temporal validity properties as read back from Neo4j (ISO-8601). */
export interface EdgeValidity {
  /** Valid-time start — when the fact became true in the world. */
  validFrom: string | null;
  /** Valid-time end — null while the fact is still true. */
  validTo: string | null;
  /** Transaction-time start — when we recorded the assertion. */
  recordedAt: string | null;
  /** Transaction-time end — null while the assertion has not been retracted. */
  invalidatedAt: string | null;
}

/**
 * Cypher assignment list (no leading/trailing comma) that stamps a *new* edge with
 * its bi-temporal validity. Insert it inside an `ON CREATE SET` / `CREATE … SET`
 * clause, comma-separated from the caller's own assignments.
 *
 *   MERGE (a)-[r:REL]->(b)
 *   ON CREATE SET r.confidence = $confidence, ${edgeValidityOnCreateSet("r")}
 *
 * Requires the `$validFrom` param from {@link edgeValidityParams} to be bound.
 * `validFrom` falls back to `datetime()` (now) when the observed time is unknown;
 * `recordedAt` is always now; both open-ended bounds start null.
 */
export function edgeValidityOnCreateSet(relVar = "r"): string {
  assertVar(relVar);
  return (
    `${relVar}.validFrom = coalesce(datetime($validFrom), datetime()), ` +
    `${relVar}.validTo = null, ` +
    `${relVar}.recordedAt = datetime(), ` +
    `${relVar}.invalidatedAt = null`
  );
}

/**
 * Cypher assignment list (no leading/trailing comma) for the `ON MATCH SET` of an
 * upsert. An upsert re-asserts that the edge holds *now*, so it preserves the
 * original lower bounds (`coalesce`, falling back to observed/now only when never
 * stamped) and reopens the upper bounds — reviving an edge that a prior
 * supersession had closed. Requires `$validFrom` from {@link edgeValidityParams}.
 */
export function edgeValidityOnMatchSet(relVar = "r"): string {
  assertVar(relVar);
  return (
    `${relVar}.validFrom = coalesce(${relVar}.validFrom, datetime($validFrom), datetime()), ` +
    `${relVar}.recordedAt = coalesce(${relVar}.recordedAt, datetime()), ` +
    `${relVar}.validTo = null, ` +
    `${relVar}.invalidatedAt = null`
  );
}

/**
 * Cypher assignment list (no leading/trailing comma) that *closes* an edge on
 * supersession — stamping both the valid-time and transaction-time upper bounds
 * without touching the lower bounds or any other property. Idempotent: an
 * already-closed edge keeps its original close time (`coalesce`).
 *
 * Requires the `$closedAt` param from {@link edgeCloseParams} to be bound.
 */
export function edgeCloseOnSupersedeSet(relVar = "old"): string {
  assertVar(relVar);
  return (
    `${relVar}.validTo = coalesce(${relVar}.validTo, datetime($closedAt)), ` +
    `${relVar}.invalidatedAt = coalesce(${relVar}.invalidatedAt, datetime($closedAt))`
  );
}

/** A Cypher predicate selecting only edges that are currently open (not closed). */
export function edgeOpenPredicate(relVar = "old"): string {
  assertVar(relVar);
  return `${relVar}.validTo IS NULL AND ${relVar}.invalidatedAt IS NULL`;
}

/**
 * Build the `$validFrom` param for a create write. `observedAt` is the event /
 * valid time of the fact; pass the source timestamp when known, otherwise omit
 * (null) and the Cypher falls back to `datetime()` (now).
 */
export function edgeValidityParams(observedAt?: string | Date | null): {
  validFrom: string | null;
} {
  return { validFrom: toIso(observedAt) };
}

/** Build the `$closedAt` param for a supersession close write (defaults to now). */
export function edgeCloseParams(closedAt?: string | Date | null): {
  closedAt: string;
} {
  return { closedAt: toIso(closedAt) ?? new Date().toISOString() };
}

/**
 * Build the time-aware read filter. Returns a Cypher predicate over `relVar` plus
 * the `$asOf` / `$asKnownAt` params to bind. Defaults select "currently valid,
 * currently known" (both axes = now), so a caller that passes neither `asOf` nor
 * `asKnownAt` sees exactly today's facts.
 *
 * Unstamped legacy edges (null lower bounds) are treated as always-valid /
 * always-known via the `IS NULL OR` guards, so the filter is behaviour-preserving
 * even before the backfill has run.
 *
 *   MATCH (n)-[r]-(m)
 *   WHERE ${filter.clause}          // relVar = "r"
 *
 * For a variable-length path, apply per-relationship:
 *   WHERE ALL(rel IN relationships(path) WHERE ${buildValidityFilter("rel", …).clause})
 */
export function buildValidityFilter(
  relVar: string,
  opts: { asOf?: string | Date | null; asKnownAt?: string | Date | null } = {},
): { clause: string; params: { asOf: string; asKnownAt: string } } {
  assertVar(relVar);
  const now = new Date().toISOString();
  const asOf = toIso(opts.asOf) ?? now;
  const asKnownAt = toIso(opts.asKnownAt) ?? now;
  const clause =
    `(${relVar}.validFrom IS NULL OR ${relVar}.validFrom <= datetime($asOf)) AND ` +
    `(${relVar}.validTo IS NULL OR ${relVar}.validTo > datetime($asOf)) AND ` +
    `(${relVar}.recordedAt IS NULL OR ${relVar}.recordedAt <= datetime($asKnownAt)) AND ` +
    `(${relVar}.invalidatedAt IS NULL OR ${relVar}.invalidatedAt > datetime($asKnownAt))`;
  return { clause, params: { asOf, asKnownAt } };
}

/**
 * Read the four validity columns from a Neo4j record produced with the
 * `${prefix}ValidFrom` etc. column aliases (all `toString(...)`-projected). Missing
 * columns yield null so the helper is safe across queries that don't project them.
 */
export function readEdgeValidity(
  get: (key: string) => unknown,
  prefix = "",
): EdgeValidity {
  const col = (name: string): string | null => {
    const v = get(`${prefix}${name}`);
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    validFrom: col("validFrom"),
    validTo: col("validTo"),
    recordedAt: col("recordedAt"),
    invalidatedAt: col("invalidatedAt"),
  };
}

/**
 * Cypher RETURN projection (no leading/trailing comma) exposing the four validity
 * columns as ISO strings, prefixed so multiple edges can be projected in one row.
 * `readEdgeValidity(get, prefix)` reads them back.
 */
export function edgeValidityReturn(relVar = "r", prefix = ""): string {
  assertVar(relVar);
  assertPrefix(prefix);
  return (
    `toString(${relVar}.validFrom) AS ${prefix}validFrom, ` +
    `toString(${relVar}.validTo) AS ${prefix}validTo, ` +
    `toString(${relVar}.recordedAt) AS ${prefix}recordedAt, ` +
    `toString(${relVar}.invalidatedAt) AS ${prefix}invalidatedAt`
  );
}

/** Normalise an optional Date | ISO string to an ISO string, or null. */
function toIso(value?: string | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

// Cypher variable names are interpolated into query strings; they must be plain
// identifiers so nothing hostile can reach the query text through this seam.
const VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertVar(relVar: string): void {
  if (!VAR_PATTERN.test(relVar)) {
    throw new Error(`temporal: unsafe Cypher variable name "${relVar}"`);
  }
}

// A column-alias prefix is interpolated into the RETURN aliases, so it is the
// same injection surface as the relationship variable. Empty (the default, no
// prefixing) is allowed; anything else must be a plain identifier fragment.
const PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertPrefix(prefix: string): void {
  if (prefix !== "" && !PREFIX_PATTERN.test(prefix)) {
    throw new Error(`temporal: unsafe Cypher column-alias prefix "${prefix}"`);
  }
}
