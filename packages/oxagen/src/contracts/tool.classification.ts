import { z } from "zod";

/**
 * Safety classification of a tool version (MC spec §6.9 part 1, ADR-065).
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
