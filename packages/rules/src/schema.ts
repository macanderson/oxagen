/**
 * Authoring-side validation for a rule set. Everything an author can get
 * wrong that the type system cannot see is rejected here, at publish time —
 * a rule set that parses is one the evaluator can judge deterministically.
 */
import { z } from "zod";
import { CONDITION_OPS, type Condition, type RuleSet } from "./types";

const conditionLeafSchema = z
  .object({
    fact: z
      .string()
      .min(1)
      .regex(
        /^(input|facts|call)(\.[A-Za-z0-9_-]+)*$/,
        "fact paths start at input., facts. or call. and use dot-separated keys",
      ),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((leaf, issues) => {
    if (leaf.op !== "exists" && !("value" in leaf)) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        message: `op "${leaf.op}" needs a value; only "exists" tests bare presence`,
      });
    }
  });

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).max(32) }).strict(),
    z.object({ any: z.array(conditionSchema).max(32) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    conditionLeafSchema,
  ]),
);

const decisionRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "rule ids are lowercase slugs"),
    description: z.string().min(1).max(500),
    capability: z
      .string()
      .min(1)
      .max(128)
      .regex(
        /^[a-z0-9_]+\*?$|^\*$/,
        "an exact capability name, a prefix ending in *, or *",
      ),
    priority: z.number().int().min(-1000).max(1000).optional(),
    when: conditionSchema.optional(),
    effect: z.enum(["allow", "deny", "require_approval"]),
    requires_facts: z.array(z.string().min(1).max(128)).max(16).optional(),
  })
  .strict();

export const ruleSetSchema: z.ZodType<RuleSet> = z
  .object({
    schema: z.literal("oxagen.decision-rules.v1"),
    rules: z.array(decisionRuleSchema).max(256),
  })
  .strict()
  .superRefine((set, issues) => {
    const seen = new Set<string>();
    for (const rule of set.rules) {
      if (seen.has(rule.id)) {
        issues.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate rule id "${rule.id}" — ids are the audit citation and must be unique`,
        });
      }
      seen.add(rule.id);
    }
  });

/** Parse and validate an authored rule set, throwing zod's error on failure. */
export function parseRuleSet(raw: unknown): RuleSet {
  return ruleSetSchema.parse(raw);
}
