/**
 * Shared schema-registry validator. See
 * docs/specs/workspace-schema-registry/spec.md §7.3, §8, §16.2.
 *
 * Pure functions — no DB, no IO. Validates a node or relationship payload
 * against the workspace's pinned active vocabulary (`PinnedSchema`), which
 * the handler layer resolves via `getPinnedSchema`. This module is the
 * single source of truth for property validation: it backs both the
 * `schema.validate.node` / `schema.validate.relationship` contracts (builder UI)
 * and the ingestion property-validation seam in `mutations/upsert-entity.ts`.
 *
 * The structure mirrors `validateConfigAgainstSchema` in
 * `connector-schema-loader.ts` (same `FieldError` shape and codes) so the two
 * validators read the same way.
 *
 * The `PinnedSchema` type is the active-vocabulary contract shared with the
 * handler layer (`getPinnedSchema` returns this exact shape). It lives here,
 * in a package ingestion already depends on, to avoid a circular dependency
 * between ingestion and handlers.
 */

// ── Field-error shape (matches connector-schema-loader) ───────────────────────

/** Validation-rule codes — superset shared with connector-schema-loader. */
export type SchemaFieldErrorCode =
  | "required"
  | "min"
  | "max"
  | "minItems"
  | "maxItems"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "type"
  | "oneOf"
  | "unknown";

/** Field-level validation error. */
export interface SchemaFieldError {
  field: string;
  message: string;
  /**
   * Machine-readable rule that failed. `minLength`/`maxLength` collapse to
   * `min`/`max` on the contract output (the contract's `FieldError.code` enum
   * has no length variants); callers that surface the contract shape map them.
   */
  code: SchemaFieldErrorCode;
}

// ── PinnedSchema (active vocabulary) — shared with getPinnedSchema ───────────

/** A property definition on a label or relationship type. */
export interface PinnedProperty {
  key: string;
  dataType:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "date"
    | "datetime"
    | "url"
    | "email"
    | "enum"
    | "json"
    | "array";
  required: boolean;
  description: string | null;
  enumValues: string[] | null;
  itemType: string | null;
  /** Constraint bag mirroring the connector FieldValidation numeric/string rules. */
  constraints: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
  example: string | null;
}

/** A node label in the active vocabulary. */
export interface PinnedLabel {
  /** Owning schema name (for grounding/diagnostics). */
  schemaName: string;
  name: string;
  displayName: string;
  description: string | null;
  naturalKeyProps: string[];
  properties: PinnedProperty[];
}

/** A relationship type in the active vocabulary. */
export interface PinnedRelationshipType {
  schemaName: string;
  name: string;
  displayName: string;
  description: string | null;
  startLabel: string | null;
  endLabel: string | null;
  cardinality: "one_to_one" | "one_to_many" | "many_to_many" | null;
  properties: PinnedProperty[];
}

/**
 * The resolved active vocabulary for a workspace. Returned by
 * `getPinnedSchema`; consumed by ingestion grounding/validation and the
 * ontology Cypher guard.
 */
export interface PinnedSchema {
  registryId: string;
  versionId: string;
  versionNumber: number;
  enforcementMode: "strict" | "lenient" | "off";
  conformanceFloor: number;
  labels: PinnedLabel[];
  relationshipTypes: PinnedRelationshipType[];
}

// ── Conformance score formula constants ───────────────────────────────────────
//
// score = 1 − (weighted missing-required + type-error penalties) / total-evaluated
//
// Required-property misses are weighted higher than optional/type penalties so a
// schema-defining field that's absent costs more than a wrongly-typed optional.
// Weights are named so the math is auditable and unit-tested.

/** Penalty weight for a missing REQUIRED property (heaviest). */
export const MISSING_REQUIRED_WEIGHT = 1.0;
/** Penalty weight for a property present but of the wrong type / failing a constraint. */
export const TYPE_ERROR_WEIGHT = 0.5;
/** Penalty weight for a missing OPTIONAL property (lightest — informational). */
export const MISSING_OPTIONAL_WEIGHT = 0.25;

/** Outcome of a validation pass (mirrors the contract `outcome` enum). */
export type ConformanceOutcome =
  | "accepted"
  | "rejected"
  | "written_below_floor";

/** Result of validating a node or relationship against the active vocabulary. */
export interface SchemaValidationResult {
  valid: boolean;
  conformanceScore: number;
  errors: SchemaFieldError[];
  missingRequired: string[];
  outcome: ConformanceOutcome;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a node `{ label, properties }` against the pinned active vocabulary.
 *
 * When the label is not in the active vocabulary, the node is treated as fully
 * conformant (score 1, accepted): an un-modeled label has no constraints to
 * violate — the registry only grounds/validates labels it knows about.
 */
export function validateNodeAgainstSchema(
  node: { label: string; properties: Record<string, unknown> },
  pinnedSchema: PinnedSchema,
): SchemaValidationResult {
  const label = pinnedSchema.labels.find((l) => l.name === node.label);
  if (!label) {
    return passthroughResult(pinnedSchema);
  }
  return evaluateProperties(label.properties, node.properties, pinnedSchema);
}

/**
 * Validate a relationship `{ type, startLabel, endLabel, properties }` against
 * the pinned active vocabulary.
 *
 * The matching relationship type is resolved by name, preferring a definition
 * whose `startLabel`/`endLabel` constraints (when present) match the supplied
 * endpoints. An endpoint that violates a declared start/end constraint produces
 * a `type`-coded error on the corresponding field. Unknown relationship type →
 * pass-through (score 1, accepted), same as nodes.
 */
export function validateRelationshipAgainstSchema(
  rel: {
    type: string;
    startLabel?: string;
    endLabel?: string;
    properties: Record<string, unknown>;
  },
  pinnedSchema: PinnedSchema,
): SchemaValidationResult {
  const candidates = pinnedSchema.relationshipTypes.filter(
    (r) => r.name === rel.type,
  );
  if (candidates.length === 0) {
    return passthroughResult(pinnedSchema);
  }

  // Prefer the most specific endpoint match; fall back to the first definition.
  const def =
    candidates.find(
      (r) =>
        (r.startLabel == null || r.startLabel === rel.startLabel) &&
        (r.endLabel == null || r.endLabel === rel.endLabel),
    ) ?? candidates[0]!;

  const result = evaluateProperties(
    def.properties,
    rel.properties,
    pinnedSchema,
  );

  // Endpoint-constraint violations are surfaced as `type` errors but do NOT
  // factor into the property-based conformance score (they are structural, not
  // property-level). They still flip `valid` to false.
  const endpointErrors: SchemaFieldError[] = [];
  if (
    def.startLabel != null &&
    rel.startLabel != null &&
    def.startLabel !== rel.startLabel
  ) {
    endpointErrors.push({
      field: "startLabel",
      message: `${rel.type} must start at ${def.startLabel}, got ${rel.startLabel}`,
      code: "type",
    });
  }
  if (
    def.endLabel != null &&
    rel.endLabel != null &&
    def.endLabel !== rel.endLabel
  ) {
    endpointErrors.push({
      field: "endLabel",
      message: `${rel.type} must end at ${def.endLabel}, got ${rel.endLabel}`,
      code: "type",
    });
  }

  if (endpointErrors.length === 0) return result;

  const errors = [...result.errors, ...endpointErrors];
  const valid = false;
  return {
    valid,
    conformanceScore: result.conformanceScore,
    errors,
    missingRequired: result.missingRequired,
    outcome: deriveOutcome(valid, result.conformanceScore, pinnedSchema),
  };
}

// ── Internal evaluation ─────────────────────────────────────────────────────

/**
 * Core property evaluation shared by node + relationship validation.
 *
 * Walks each declared property: accumulates required-misses, type errors, and
 * constraint failures into a weighted penalty, then computes the conformance
 * score over the total number of evaluated (declared) properties.
 */
function evaluateProperties(
  declared: PinnedProperty[],
  values: Record<string, unknown>,
  pinnedSchema: PinnedSchema,
): SchemaValidationResult {
  const errors: SchemaFieldError[] = [];
  const missingRequired: string[] = [];
  let penalty = 0;

  for (const prop of declared) {
    const value = values[prop.key];
    const absent = value === undefined || value === null || value === "";

    if (absent) {
      if (prop.required) {
        missingRequired.push(prop.key);
        errors.push({
          field: prop.key,
          message: `${prop.key} is required`,
          code: "required",
        });
        penalty += MISSING_REQUIRED_WEIGHT;
      } else {
        // Optional absent — informational penalty, no error surfaced.
        penalty += MISSING_OPTIONAL_WEIGHT;
      }
      continue;
    }

    // Present — type + constraint checks. Each failure adds a type-error penalty
    // (capped per property so one field never sinks the whole score).
    const fieldErrors = checkValue(prop, value);
    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors);
      penalty += TYPE_ERROR_WEIGHT;
    }
  }

  const total = declared.length;
  // No declared properties → nothing to violate → perfect score.
  const conformanceScore = total === 0 ? 1 : clamp01(1 - penalty / total);
  const valid = errors.length === 0;

  return {
    valid,
    conformanceScore,
    errors,
    missingRequired,
    outcome: deriveOutcome(valid, conformanceScore, pinnedSchema),
  };
}

/** Validate a present value against its property's dataType + constraints. */
function checkValue(prop: PinnedProperty, value: unknown): SchemaFieldError[] {
  const errors: SchemaFieldError[] = [];
  const typeError = checkDataType(prop, value);
  if (typeError) {
    errors.push(typeError);
    // A wrong type makes constraint checks meaningless — stop here.
    return errors;
  }

  const c = prop.constraints;

  if (typeof value === "number") {
    if (c.min !== undefined && value < c.min) {
      errors.push({
        field: prop.key,
        message: `${prop.key} must be ≥ ${c.min}`,
        code: "min",
      });
    }
    if (c.max !== undefined && value > c.max) {
      errors.push({
        field: prop.key,
        message: `${prop.key} must be ≤ ${c.max}`,
        code: "max",
      });
    }
  }

  if (typeof value === "string") {
    if (c.minLength !== undefined && value.length < c.minLength) {
      errors.push({
        field: prop.key,
        message: `${prop.key} must be at least ${c.minLength} characters`,
        code: "minLength",
      });
    }
    if (c.maxLength !== undefined && value.length > c.maxLength) {
      errors.push({
        field: prop.key,
        message: `${prop.key} must be at most ${c.maxLength} characters`,
        code: "maxLength",
      });
    }
    if (c.pattern !== undefined && !safeTest(c.pattern, value)) {
      errors.push({
        field: prop.key,
        message: `${prop.key} does not match required format`,
        code: "pattern",
      });
    }
  }

  if (
    prop.dataType === "enum" &&
    prop.enumValues &&
    typeof value === "string"
  ) {
    if (!prop.enumValues.includes(value)) {
      errors.push({
        field: prop.key,
        message: `${prop.key} must be one of: ${prop.enumValues.join(", ")}`,
        code: "oneOf",
      });
    }
  }

  return errors;
}

/** Return a `type`-coded error when `value` does not match the declared dataType. */
function checkDataType(
  prop: PinnedProperty,
  value: unknown,
): SchemaFieldError | null {
  const mk = (expected: string): SchemaFieldError => ({
    field: prop.key,
    message: `${prop.key}: expected ${expected}, got ${typeof value}`,
    code: "type",
  });

  switch (prop.dataType) {
    case "string":
    case "enum":
      return typeof value === "string" ? null : mk(prop.dataType);
    case "url":
      return typeof value === "string" && isUrl(value) ? null : mk("url");
    case "email":
      return typeof value === "string" && isEmail(value) ? null : mk("email");
    case "date":
    case "datetime":
      return isDateLike(value) ? null : mk(prop.dataType);
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : mk("number");
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : mk("integer");
    case "boolean":
      return typeof value === "boolean" ? null : mk("boolean");
    case "array":
      return Array.isArray(value) ? null : mk("array");
    case "json":
      // json accepts any object/array; reject primitives that should be structured.
      return typeof value === "object" ? null : mk("json");
    default:
      return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function passthroughResult(pinnedSchema: PinnedSchema): SchemaValidationResult {
  return {
    valid: true,
    conformanceScore: 1,
    errors: [],
    missingRequired: [],
    outcome: deriveOutcome(true, 1, pinnedSchema),
  };
}

/**
 * Map (valid, score, enforcementMode) → the validation outcome.
 *
 * - Any hard error (`!valid`) → `rejected` under strict; under lenient/off →
 *   `written_below_floor`, regardless of where the score sits relative to the
 *   conformance floor (a hard error is always surfaced, not just a low score).
 * - No errors but score below the conformance floor → `written_below_floor`.
 * - Otherwise → `accepted`.
 *
 * NOTE: the caller (ingestion seam) makes the actual write/reject decision per
 * enforcement mode; this `outcome` is the *classification* the contract returns
 * and the ClickHouse event records.
 */
function deriveOutcome(
  valid: boolean,
  score: number,
  pinnedSchema: PinnedSchema,
): ConformanceOutcome {
  if (!valid) {
    return pinnedSchema.enforcementMode === "strict"
      ? "rejected"
      : "written_below_floor";
  }
  if (score < pinnedSchema.conformanceFloor) {
    return "written_below_floor";
  }
  return "accepted";
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * "Safe" here means only that a syntactically invalid pattern cannot throw —
 * an unparseable pattern in the registry passes rather than crashing
 * validation. It is NOT safe against a catastrophically backtracking pattern:
 * both the pattern (author-supplied schema) and the value (connector-supplied
 * payload) are untrusted, and a runaway match blocks the event loop of
 * whichever worker is validating. Bounding that needs a timeout-capable regex
 * engine or a pattern linter at schema-publish time.
 */
function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // An invalid pattern in the registry should not crash validation.
    return true;
  }
}

function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isEmail(value: string): boolean {
  // Deliberately permissive: a single @, non-empty local + domain with a dot.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function isDateLike(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "string") return !Number.isNaN(Date.parse(value));
  return false;
}
