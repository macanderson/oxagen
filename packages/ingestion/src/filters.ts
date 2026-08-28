/**
 * Pipeline filter utilities.
 *
 * Each filter reads from `sourceConnection.deliveryConfig` and determines
 * whether a record should proceed to the next pipeline stage.
 *
 * Filter results are intentionally pure (no side-effects) so they can be
 * tested independently and composed by the pipeline runner.
 *
 * Glob matching uses the same picomatch-compatible mini-glob subset that the
 * connector schema YAML declares for pathFilters / labelFilters. We implement
 * it without adding a new dependency: only `*`, `**`, and literal segments
 * are supported — which covers 100% of real-world connector filter patterns.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterResult {
  filtered: boolean;
  reason?: string;
}

/**
 * Subset of sourceConnection.deliveryConfig that the filter layer reads.
 * The full JSONB blob is untyped in the DB; this interface is the typed view
 * used within the ingestion package.
 */
export interface DeliveryConfig {
  /** Allowed source record types. Records whose `type` is not in this list are
   * dropped at Stage 1 (receive). Empty / absent = allow all. */
  recordTypeFilters?: string[];

  /** Glob patterns for file paths. Matching records are dropped at Stage 2
   * (normalize). Empty / absent = allow all. */
  pathFilters?: string[];

  /** Glob patterns for issue/PR label names. Records with a matching label
   * are dropped at Stage 2 (normalize). Empty / absent = allow all. */
  labelFilters?: string[];

  /** Sync delivery method — controls cadence scheduling. */
  syncMethod?: "manual" | "polling" | "webhook";

  /** Polling interval in seconds (only used when syncMethod === "polling"). */
  syncIntervalSeconds?: number;

  /**
   * Per-tenant embedding opt-out. Connector schemas do not expose this in
   * their UI; it only applies when a tenant's stored config sets it.
   */
  semanticInference?: {
    enabled: boolean;
    /** Per-record-type toggle. Key = sourceRecordType; value = whether to embed. */
    perRecordType?: Record<string, boolean>;
  };
}

// ---------------------------------------------------------------------------
// Glob helpers
// ---------------------------------------------------------------------------

/**
 * Compile a glob pattern into a RegExp.
 *
 * Supported patterns:
 *   `**`   matches any path segment sequence (including `/`)
 *   `*`    matches anything except `/`
 *   `?`    matches a single non-`/` character
 *   Literal characters are escaped.
 *
 * Examples:
 *   "node_modules/**"  → matches "node_modules/foo/bar.ts"
 *   "*.lock"           → matches "package-lock.json", "yarn.lock"
 *   "dist/**"          → matches "dist/index.js"
 */
function globToRegExp(pattern: string): RegExp {
  let reStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    if (ch === "*" && pattern[i + 1] === "*") {
      // ** — matches anything including slashes
      reStr += ".*";
      i += 2;
      // consume optional trailing slash
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      // * — matches anything except /
      reStr += "[^/]*";
      i++;
    } else if (ch === "?") {
      reStr += "[^/]";
      i++;
    } else {
      // Escape special regex characters
      reStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${reStr}$`);
}

/**
 * Returns true if `value` matches ANY of the provided glob patterns.
 * Case-sensitive (consistent with filesystem behaviour on Linux/macOS).
 */
export function matchGlobPattern(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage 1 filter: record type
// ---------------------------------------------------------------------------

/**
 * Stage 1 — receive gate.
 *
 * Checks `deliveryConfig.recordTypeFilters`. If the list is non-empty, the
 * record's `sourceRecordType` must appear in it.
 */
export function applyRecordTypeFilter(
  sourceRecordType: string,
  allowedTypes: string[],
): FilterResult {
  if (allowedTypes.length === 0) return { filtered: false };
  if (allowedTypes.includes(sourceRecordType)) return { filtered: false };
  return {
    filtered: true,
    reason: "record_type_not_allowed",
  };
}

// ---------------------------------------------------------------------------
// Stage 2 filters: path + label
// ---------------------------------------------------------------------------

/**
 * Stage 2 — normalize gate: path filter.
 *
 * Checks `record.properties.path` against `deliveryConfig.pathFilters`.
 * If the path matches any pattern the record is filtered out.
 *
 * Records without a `path` property pass through (filter is only applicable
 * to source/file record types).
 */
export function applyPathFilter(
  properties: Record<string, unknown>,
  patterns: string[],
): FilterResult {
  if (patterns.length === 0) return { filtered: false };
  const path = properties["path"];
  if (typeof path !== "string") return { filtered: false };
  if (matchGlobPattern(path, patterns)) {
    return { filtered: true, reason: "path_filtered" };
  }
  return { filtered: false };
}

/**
 * Stage 2 — normalize gate: label filter.
 *
 * Checks `record.properties.labels` against `deliveryConfig.labelFilters`.
 * `labels` may be:
 *   - an array of strings: ["bug", "feature"]
 *   - an array of objects with a `name` field: [{ name: "bug" }]
 *
 * If ANY label matches a filter pattern, the record is filtered out.
 *
 * Records without labels pass through.
 */
export function applyLabelFilter(
  properties: Record<string, unknown>,
  patterns: string[],
): FilterResult {
  if (patterns.length === 0) return { filtered: false };
  const raw = properties["labels"];
  if (!Array.isArray(raw) || raw.length === 0) return { filtered: false };

  const labelNames: string[] = raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && "name" in item) {
        const name = (item as Record<string, unknown>)["name"];
        return typeof name === "string" ? name : "";
      }
      return "";
    })
    .filter((n) => n.length > 0);

  for (const label of labelNames) {
    if (matchGlobPattern(label, patterns)) {
      return { filtered: true, reason: "label_filtered" };
    }
  }
  return { filtered: false };
}

// ---------------------------------------------------------------------------
// Stage 5 gate: embeddings
// ---------------------------------------------------------------------------

/**
 * Stage 5 — embed gate.
 *
 * Returns true when embedding should proceed for this record,
 * false when it should be skipped.
 *
 * Rules (applied in order):
 *  1. If `semanticInference` is absent → default enabled (true).
 *  2. If `semanticInference.enabled` is false → skip (false).
 *  3. If `perRecordType[sourceRecordType]` is explicitly false → skip (false).
 *  4. Otherwise → proceed (true).
 */
export function shouldRunInference(
  sourceRecordType: string,
  semanticInference: DeliveryConfig["semanticInference"],
): boolean {
  if (!semanticInference) return true;
  if (!semanticInference.enabled) return false;
  if (
    semanticInference.perRecordType &&
    semanticInference.perRecordType[sourceRecordType] === false
  ) {
    return false;
  }
  return true;
}
