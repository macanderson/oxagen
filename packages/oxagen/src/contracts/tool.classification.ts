import { z } from "zod";

/**
 * Safety classification of a tool version (MC spec §6.9 part 1, ADR-072).
 *
 * Classification describes a tool and decides nothing by itself: a class kill
 * switch (`set_kill_switch` with `target.kind = "class"`) matches a version by
 * its consequence tags at call time, and approval rules and mandates (their
 * own lanes) are written against it. The risk grade the classifier sets is
 * carried on the wire beside this object and stored on the version's
 * `classified_risk_grade`; the declared `risk_grade` and the checksum over it
 * stay as published. A new version of the tool starts with the classification
 * of the version it replaces.
 *
 * The consequence-tag starter set is the spec's; a customer extends it with
 * any tag that fits the pattern, so the schema admits the pattern and not the
 * list. Measures are paths into the tool's input, each with a type and, for
 * money, the path to its currency.
 */
export const CONSEQUENCE_TAG_STARTER_SET = [
  "moves_money",
  "destroys_data",
  "alters_production",
  "communicates_externally",
  "changes_access",
  "changes_entitlement",
] as const;

/** snake_case, 2–64 characters: the starter set and every customer tag. */
export const consequenceTagSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,63}$/,
    "a consequence tag is snake_case, 2 to 64 characters",
  );

export const toolSideEffectClassSchema = z.enum([
  "read",
  "write",
  "irreversible",
]);
export const toolEgressClassSchema = z.enum([
  "local",
  "org_tenant",
  "third_party",
]);
export const toolRiskGradeSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

/** A JSONPath into the call's input, e.g. `$.amount`. */
const inputPathSchema = z
  .string()
  .regex(
    /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+$/,
    "a path into the input, starting with $",
  );

export const toolMeasureSchema = z
  .object({
    path: inputPathSchema,
    type: z.enum([
      "money",
      "count",
      "identifier",
      "environment",
      "table",
      "text",
    ]),
    /** For `money`: where the call carries the currency. */
    currencyPath: inputPathSchema.optional(),
    /** For `count`: what is counted (rows, recipients, principals). */
    unit: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.type === "money" && !m.currencyPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currencyPath"],
        message: "a money measure names the path to its currency",
      });
    }
  });

export const toolClassificationSchema = z
  .object({
    sideEffect: toolSideEffectClassSchema,
    egress: toolEgressClassSchema,
    consequenceTags: z.array(consequenceTagSchema).max(32),
    measures: z.record(
      z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/, "a measure name is snake_case"),
      toolMeasureSchema,
    ),
    dataClasses: z.array(z.string().min(1).max(64)).max(64),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.consequenceTags).size !== c.consequenceTags.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consequenceTags"],
        message: "a tag appears once",
      });
    }
  });

export type ToolClassification = z.output<typeof toolClassificationSchema>;
export type ToolRiskGrade = z.output<typeof toolRiskGradeSchema>;

// ── The effective classification ────────────────────────────────────────────
//
// A tool version states its consequences in two places, written by two
// capabilities behind two different gates: `consequence_tags` (text[]) is the
// declared half, written by `publish_tool_declaration` and `import_tools`
// behind `assertConsequenceRole`; `classification->'consequenceTags'` is the
// classified half, written by `set_tool_classification` behind Owner/Admin.
// Both draw on one vocabulary (`consequenceTagSchema`).
//
// EVERY reader that decides authority or a floor must come through the
// functions below, and the reason is the whole history of this file: the
// kill-switch gate once read only the jsonb and left every declared-tag tool
// running while `list_kill_switches` reported the switch on (#2958); the
// auto-approval floor once read only the column and ignored a `destroys_data`
// an administrator had set; and the rule-authoring gate once read only the
// column while the floor read the union, so an Admin could author a rule over
// a tool classified `moves_money` that they were not accountable for and the
// floor would then enforce the tag the gate never saw. Three instances of one
// fact in two places with a reader on one of them. One function, so a fourth
// cannot be written by accident.

/** The shape every reader passes in: the two halves as the row carries them. */
export interface ClassificationHalves {
  consequenceTags: readonly string[] | null;
  classification: unknown;
}

/** The classified half, read defensively — a malformed jsonb contributes nothing. */
function classifiedPart(raw: unknown): {
  sideEffect: string | null;
  consequenceTags: string[];
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { sideEffect: null, consequenceTags: [] };
  }
  const c = raw as Record<string, unknown>;
  const tags = Array.isArray(c.consequenceTags)
    ? c.consequenceTags.filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      )
    : [];
  return {
    sideEffect: typeof c.sideEffect === "string" ? c.sideEffect : null,
    consequenceTags: tags,
  };
}

/**
 * The consequence tags a version carries, from BOTH halves, deduped.
 *
 * A union, never a replacement, and the asymmetry is the argument. Union is
 * monotonic for a floor — it only ever adds reasons a call needs a person:
 *
 *   declared {}, classified {destroys_data} → {destroys_data}: an administrator
 *     RAISED the floor.
 *   declared {destroys_data}, classified {} → {destroys_data}: an administrator
 *     CANNOT lower what the manifest declared.
 *
 * Replacement would allow the second, which is why the two halves are unioned
 * rather than one preferred over the other.
 *
 * SORTED, and that is part of the contract rather than tidiness. Unsorted, the
 * order depended on which half contributed a tag first, which is exactly the
 * kind of unspecified representation that turns load-bearing the moment
 * anything compares, stores or digests the result — and a rule's
 * `authoredConsequences` stamp does compare a stored set against a later one.
 * Sorting once, here, gives all five readers the same answer and gives that
 * comparison a stable basis.
 */
export function unionConsequenceTags(row: ClassificationHalves): string[] {
  const tags = new Set<string>();
  for (const t of row.consequenceTags ?? []) {
    if (typeof t === "string" && t.length > 0) tags.add(t);
  }
  for (const t of classifiedPart(row.classification).consequenceTags) {
    tags.add(t);
  }
  return [...tags].sort();
}

/** Side-effect classes from least to most severe (`toolSideEffectClassSchema`). */
const SIDE_EFFECT_SEVERITY: readonly string[] = [
  "read",
  "write",
  "irreversible",
];

/**
 * The effective side-effect class: the more severe of the declared and the
 * classified value, with an unknown or absent value contributing nothing.
 *
 * A max for the same reason the tags are a union. There is no declared
 * side-effect COLUMN today — the class lives only inside `classification` — so
 * this currently reduces to the classified value. It is written as a max
 * anyway, so the day a declared column lands, a reclassification still cannot
 * lower what the manifest declared.
 */
export function effectiveSideEffect(
  row: ClassificationHalves & { sideEffect?: string | null },
): string | null {
  const rank = (v: string | null) =>
    v === null ? -1 : SIDE_EFFECT_SEVERITY.indexOf(v);
  const declared = row.sideEffect ?? null;
  const classified = classifiedPart(row.classification).sideEffect;
  return rank(declared) >= rank(classified) ? declared : classified;
}
