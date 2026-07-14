/**
 * trigger-conditions.ts — the single source of truth for automation trigger
 * condition trees.
 *
 * An automation event trigger fires when a graph node change (node.created /
 * node.updated / node.deleted) satisfies a **nested boolean condition tree**
 * over the node's properties — e.g. `status eq "merged" AND (priority eq "P0"
 * OR label eq "release-blocker")`.
 *
 * This module is deliberately dependency-free (only `zod`) so it can be shared
 * across every layer without pulling in a runtime:
 *   - contracts (`automation.create` / `automation.update`) validate the tree,
 *   - the Inngest matcher (`playbook.trigger.match`) evaluates it against an
 *     incoming node's property snapshot,
 *   - the app's condition-builder UI renders it and uses the operator metadata
 *     to drive schema-typed pickers.
 *
 * Property keys, operators (typed by the property's schema `dataType`), and
 * enum values are all sourced from the workspace schema registry
 * (`schema.registry.get`) at author time — this module only defines the shape
 * and the evaluation semantics.
 */
import { z } from "zod";

// ── Operators ────────────────────────────────────────────────────────────────

/**
 * Every comparison an individual condition leaf can express. The subset that is
 * *offered* for a given property is narrowed by its schema `dataType` (see
 * {@link operatorsForDataType}); the evaluator here implements all of them
 * generically with type coercion.
 */
export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "in",
  "not_in",
  "before",
  "after",
  "changed",
  "exists",
  "not_exists",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const conditionOperatorSchema = z.enum(CONDITION_OPERATORS);

/** Human-readable operator labels for the builder UI. */
export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "greater than or equal",
  lt: "less than",
  lte: "less than or equal",
  contains: "contains",
  in: "is any of",
  not_in: "is none of",
  before: "before",
  after: "after",
  changed: "changed",
  exists: "is set",
  not_exists: "is not set",
};

/** Operators that take NO value input (unary). */
export const VALUELESS_OPERATORS = new Set<ConditionOperator>([
  "changed",
  "exists",
  "not_exists",
]);

/** Operators whose value is a LIST (multi-select) rather than a scalar. */
export const ARRAY_OPERATORS = new Set<ConditionOperator>(["in", "not_in"]);

export function operatorRequiresValue(op: ConditionOperator): boolean {
  return !VALUELESS_OPERATORS.has(op);
}

export function operatorExpectsArray(op: ConditionOperator): boolean {
  return ARRAY_OPERATORS.has(op);
}

/**
 * Which operators the builder should offer for a schema property, keyed by the
 * registry `data_type` (`schema_registry.properties.data_type`). Anything not
 * listed falls back to {@link DEFAULT_OPERATORS}.
 */
export const OPERATORS_BY_DATA_TYPE: Record<
  string,
  readonly ConditionOperator[]
> = {
  string: ["eq", "neq", "contains", "changed", "exists", "not_exists"],
  url: ["eq", "neq", "contains", "changed", "exists", "not_exists"],
  email: ["eq", "neq", "contains", "changed", "exists", "not_exists"],
  enum: ["eq", "neq", "in", "not_in", "changed", "exists", "not_exists"],
  number: [
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "changed",
    "exists",
    "not_exists",
  ],
  integer: [
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "changed",
    "exists",
    "not_exists",
  ],
  boolean: ["eq", "neq", "changed", "exists", "not_exists"],
  date: ["eq", "before", "after", "changed", "exists", "not_exists"],
  datetime: ["eq", "before", "after", "changed", "exists", "not_exists"],
  json: ["changed", "exists", "not_exists"],
  array: ["contains", "changed", "exists", "not_exists"],
};

const DEFAULT_OPERATORS: readonly ConditionOperator[] = [
  "eq",
  "neq",
  "changed",
  "exists",
  "not_exists",
];

export function operatorsForDataType(
  dataType: string | undefined | null,
): readonly ConditionOperator[] {
  return (dataType && OPERATORS_BY_DATA_TYPE[dataType]) || DEFAULT_OPERATORS;
}

// ── Condition tree shape ─────────────────────────────────────────────────────

/** Max nesting depth of a condition tree — abuse guard, ample for real UIs. */
export const MAX_CONDITION_DEPTH = 6;
/** Max children per group — abuse guard. */
export const MAX_GROUP_CHILDREN = 50;

export const conditionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);

export type ConditionValue = z.infer<typeof conditionValueSchema>;

/** A single comparison of one schema property against a value. */
export interface ConditionLeaf {
  kind: "condition";
  /** Stable id — drives React keys and the human-facing "1 AND 2" numbering. */
  id: string;
  /** Property KEY from the watched label's schema (e.g. `status`). */
  property: string;
  operator: ConditionOperator;
  /** Omitted for unary operators (changed/exists/not_exists). */
  value?: ConditionValue;
}

/** A boolean group combining child nodes (leaves or nested groups). */
export interface ConditionGroup {
  kind: "group";
  id: string;
  combinator: "and" | "or";
  children: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

export const conditionLeafSchema: z.ZodType<ConditionLeaf> = z.object({
  kind: z.literal("condition"),
  id: z.string().min(1).max(64),
  property: z.string().min(1).max(200),
  operator: conditionOperatorSchema,
  value: conditionValueSchema.optional(),
});

// Mutually recursive schemas via z.lazy — both are module-level consts so the
// forward reference from the group to the node resolves at parse time.
export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({
    kind: z.literal("group"),
    id: z.string().min(1).max(64),
    combinator: z.enum(["and", "or"]),
    children: z.array(conditionNodeSchema).max(MAX_GROUP_CHILDREN),
  }),
);

export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([conditionLeafSchema, conditionGroupSchema]),
);

/** True when the tree nests deeper than {@link MAX_CONDITION_DEPTH}. */
export function exceedsMaxDepth(node: ConditionNode, depth = 1): boolean {
  if (node.kind !== "group") return depth > MAX_CONDITION_DEPTH;
  if (depth > MAX_CONDITION_DEPTH) return true;
  return node.children.some((c) => exceedsMaxDepth(c, depth + 1));
}

/**
 * Contract-side validator: a well-formed tree whose nesting is within bounds.
 * Use in trigger-config schemas via `.superRefine`.
 */
export const conditionTreeSchema = conditionNodeSchema.refine(
  (node) => !exceedsMaxDepth(node),
  { message: `condition tree exceeds max depth of ${MAX_CONDITION_DEPTH}` },
);

/** Legacy flat-condition schema — still accepted, normalized to a tree at eval time. */
export const legacyPropertyConditionSchema = z.object({
  property: z
    .string()
    .describe("Property name to evaluate, e.g. 'status', 'value'"),
  fromValue: z
    .unknown()
    .optional()
    .describe("Previous value the property must have had"),
  toValue: z
    .unknown()
    .optional()
    .describe("New value the property must now have"),
  operator: z
    .enum(["eq", "gt", "lt", "changed"])
    .default("eq")
    .describe(
      "Comparison operator: eq=exact, changed=any change, gt/lt=numeric",
    ),
});

/**
 * The full trigger-type-specific configuration shared by `automation.create`
 * and `automation.update`. Event fields drive graph-change triggers; schedule
 * fields drive cron triggers. `entityType` is a node label from the workspace
 * schema registry; `conditionTree` is the nested boolean condition tree over
 * that label's schema properties (the preferred, schema-driven form).
 * `propertyConditions` is the legacy flat form, retained for back-compat.
 */
export const triggerConfigSchema = z.object({
  entityType: z
    .string()
    .optional()
    .describe(
      "Watched node label (entity type) from the workspace schema registry, e.g. 'PullRequest', 'Contact'",
    ),
  eventType: z
    .enum(["node.created", "node.updated", "node.deleted"])
    .optional()
    .describe("Graph event type — required when triggerType='event'"),
  conditionTree: conditionTreeSchema
    .optional()
    .describe(
      "Nested AND/OR condition tree over the watched label's schema properties. Property keys, operators (typed by each property's dataType), and enum values are sourced from the schema registry.",
    ),
  propertyConditions: z
    .array(legacyPropertyConditionSchema)
    .optional()
    .describe(
      "DEPRECATED flat condition list (implicit AND). Prefer conditionTree; retained for back-compat and normalized to a tree at evaluation time.",
    ),
  cronExpression: z
    .string()
    .optional()
    .describe(
      "POSIX cron expression — required when triggerType='schedule', e.g. '0 9 * * 1' for Monday 9am",
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone for schedule, e.g. 'America/New_York'. Default: UTC",
    ),
});

export type TriggerConfig = z.output<typeof triggerConfigSchema>;

// ── Legacy flat conditions (back-compat) ─────────────────────────────────────

/**
 * The pre-tree condition shape persisted in existing `playbook_triggers.config`
 * rows and still accepted by the contract for back-compat. A flat list is an
 * implicit AND of equality/threshold checks.
 */
export interface LegacyPropertyCondition {
  property: string;
  operator?: "eq" | "gt" | "lt" | "changed";
  fromValue?: unknown;
  toValue?: unknown;
}

function coerceScalar(v: unknown): ConditionValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  return String(v);
}

/** Lift a legacy flat condition list into an AND-group condition tree. */
export function legacyConditionsToTree(
  conditions: readonly LegacyPropertyCondition[],
): ConditionGroup {
  return {
    kind: "group",
    id: "root",
    combinator: "and",
    children: conditions.map((c, i) => {
      const operator: ConditionOperator = c.operator ?? "eq";
      const leaf: ConditionLeaf = {
        kind: "condition",
        id: `c${i}`,
        property: c.property,
        operator,
      };
      if (operatorRequiresValue(operator)) {
        leaf.value = coerceScalar(c.toValue);
      }
      return leaf;
    }),
  };
}

/** The persisted trigger condition config — either shape may be present. */
export interface TriggerConditionConfig {
  conditionTree?: ConditionNode | null;
  propertyConditions?: LegacyPropertyCondition[] | null;
}

/**
 * Resolve whatever is stored in a trigger's config to a single root group:
 * prefer an explicit `conditionTree` (wrapping a bare leaf in an AND group),
 * else lift legacy `propertyConditions`, else an empty (always-match) group.
 */
export function resolveConditionTree(
  config: TriggerConditionConfig | null | undefined,
): ConditionGroup {
  const tree = config?.conditionTree;
  if (tree) {
    return tree.kind === "group"
      ? tree
      : { kind: "group", id: "root", combinator: "and", children: [tree] };
  }
  return legacyConditionsToTree(config?.propertyConditions ?? []);
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function asNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function asTime(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Date.parse(String(v));
}

function scalarEquals(current: unknown, expected: ConditionValue): boolean {
  if (typeof expected === "number") {
    const n = asNumber(current);
    return !Number.isNaN(n) && n === expected;
  }
  if (typeof expected === "boolean") {
    if (typeof current === "boolean") return current === expected;
    return String(current) === String(expected);
  }
  return String(current) === String(expected);
}

function evaluateLeaf(
  leaf: ConditionLeaf,
  properties: Readonly<Record<string, unknown>>,
  previousProperties?: Readonly<Record<string, unknown>>,
): boolean {
  const current = properties[leaf.property];
  const { operator, value } = leaf;

  // Presence operators handle undefined explicitly.
  if (operator === "exists") return current !== undefined && current !== null;
  if (operator === "not_exists")
    return current === undefined || current === null;
  if (operator === "changed") {
    // With previous state: fires only on an actual value change (incl. delete).
    // Without previous state (e.g. node.created): fires when the property is
    // present — mirrors the original flat-condition semantics.
    if (previousProperties !== undefined) {
      return previousProperties[leaf.property] !== current;
    }
    return current !== undefined;
  }

  // All remaining operators require the property to be present.
  if (current === undefined || current === null) return false;

  switch (operator) {
    case "eq":
      return (
        value !== undefined &&
        !Array.isArray(value) &&
        scalarEquals(current, value)
      );
    case "neq":
      return (
        value !== undefined &&
        !Array.isArray(value) &&
        !scalarEquals(current, value)
      );
    case "contains": {
      if (value === undefined || Array.isArray(value)) return false;
      if (Array.isArray(current)) {
        return current.some((el) => scalarEquals(el, value));
      }
      return String(current).includes(String(value));
    }
    case "in":
      return (
        Array.isArray(value) && value.some((el) => scalarEquals(current, el))
      );
    case "not_in":
      return (
        Array.isArray(value) && !value.some((el) => scalarEquals(current, el))
      );
    case "gt": {
      const n = asNumber(current);
      const t = asNumber(value);
      return !Number.isNaN(n) && !Number.isNaN(t) && n > t;
    }
    case "gte": {
      const n = asNumber(current);
      const t = asNumber(value);
      return !Number.isNaN(n) && !Number.isNaN(t) && n >= t;
    }
    case "lt": {
      const n = asNumber(current);
      const t = asNumber(value);
      return !Number.isNaN(n) && !Number.isNaN(t) && n < t;
    }
    case "lte": {
      const n = asNumber(current);
      const t = asNumber(value);
      return !Number.isNaN(n) && !Number.isNaN(t) && n <= t;
    }
    case "before": {
      const c = asTime(current);
      const t = asTime(value);
      return !Number.isNaN(c) && !Number.isNaN(t) && c < t;
    }
    case "after": {
      const c = asTime(current);
      const t = asTime(value);
      return !Number.isNaN(c) && !Number.isNaN(t) && c > t;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a condition tree against a node's current (and optionally previous)
 * property snapshot. An empty group matches vacuously (no constraint).
 */
export function evaluateConditionNode(
  node: ConditionNode,
  properties: Readonly<Record<string, unknown>>,
  previousProperties?: Readonly<Record<string, unknown>>,
): boolean {
  if (node.kind === "group") {
    if (node.children.length === 0) return true;
    return node.combinator === "and"
      ? node.children.every((c) =>
          evaluateConditionNode(c, properties, previousProperties),
        )
      : node.children.some((c) =>
          evaluateConditionNode(c, properties, previousProperties),
        );
  }
  return evaluateLeaf(node, properties, previousProperties);
}

/**
 * Top-level entry point for the runtime matcher: resolve the trigger config to
 * a tree (handling legacy rows) and evaluate it. Returns `true` when the node
 * change satisfies the trigger's conditions.
 */
export function evaluateTriggerConditions(
  config: TriggerConditionConfig | null | undefined,
  properties: Readonly<Record<string, unknown>>,
  previousProperties?: Readonly<Record<string, unknown>>,
): boolean {
  return evaluateConditionNode(
    resolveConditionTree(config),
    properties,
    previousProperties,
  );
}

// ── Builder helpers (pure) ───────────────────────────────────────────────────

let leafSeq = 0;

/** Generate a process-unique, non-crypto id for a new node in the builder. */
export function nextConditionId(prefix = "n"): string {
  leafSeq += 1;
  return `${prefix}${leafSeq}`;
}

export function emptyConditionLeaf(property = ""): ConditionLeaf {
  return {
    kind: "condition",
    id: nextConditionId("c"),
    property,
    operator: "eq",
    value: "",
  };
}

export function emptyConditionGroup(
  combinator: "and" | "or" = "and",
): ConditionGroup {
  return { kind: "group", id: nextConditionId("g"), combinator, children: [] };
}
