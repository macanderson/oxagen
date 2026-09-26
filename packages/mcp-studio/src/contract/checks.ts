// checks.ts: cross-field checks that zod runs and JSON Schema publishes.
//
// S0's json-schema.ts states one kind of rule as data (FieldRule). An object
// can carry only one set of extra JSON Schema keywords, so every check an
// object needs goes through withChecks at once: S0's field rules, and custom
// checks that pair a zod test with the JSON Schema that says the same thing.
import { z } from "zod";
import {
  ruleIssues,
  ruleJson,
  withJsonSchema,
  type FieldRule,
  type JsonSchema,
} from "@oxagen/oxagen/steering-repo/json-schema";

/** One problem a check finds, on the field it names. */
export interface CheckIssue {
  path: (string | number)[];
  message: string;
}

/** A check S0's FieldRule cannot state, with the JSON Schema that states it. */
export interface CustomCheck {
  issues(value: Record<string, unknown>): CheckIssue[];
  /** The `allOf` entry that publishes it, or undefined when zod alone checks it. */
  json: JsonSchema | undefined;
}

export type Check = FieldRule | CustomCheck;

function isFieldRule(check: Check): check is FieldRule {
  return "kind" in check;
}

/** What every check finds wrong with a value that passed the object's own schema. */
export function checkIssues(
  checks: readonly Check[],
  value: Record<string, unknown>,
): CheckIssue[] {
  return checks.flatMap((check) =>
    isFieldRule(check) ? ruleIssues(check, value) : check.issues(value),
  );
}

/**
 * An object schema with its cross-field checks. zod reports each broken check
 * on the field it names. The JSON Schema carries every published check as one
 * `allOf`.
 */
export function withChecks<T extends z.AnyZodObject>(
  schema: T,
  checks: readonly Check[],
): z.ZodEffects<T> {
  const refined = schema.superRefine((value, ctx) => {
    for (const issue of checkIssues(checks, value as Record<string, unknown>)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
    }
  });
  const allOf = checks.flatMap((check) => {
    if (isFieldRule(check)) return [ruleJson(check)];
    return check.json === undefined ? [] : [check.json];
  });
  // JSON Schema refuses an empty allOf, so a schema whose checks zod alone
  // can run publishes none.
  return allOf.length === 0 ? refined : withJsonSchema(refined, { allOf });
}

/** `field` needs each of `needs`: JSON Schema's `dependentRequired`. */
export function dependentRequired(
  field: string,
  needs: readonly string[],
): CustomCheck {
  return {
    issues: (value) =>
      value[field] === undefined
        ? []
        : needs
            .filter((need) => value[need] === undefined)
            .map((need) => ({
              path: [need],
              message: `${need} is required when ${field} is set`,
            })),
    json: { dependentRequired: { [field]: [...needs] } },
  };
}

/** At most one of `fields` is set. */
export function atMostOne(fields: readonly string[]): CustomCheck {
  const pairs: [string, string][] = [];
  fields.forEach((first, index) => {
    for (const second of fields.slice(index + 1)) pairs.push([first, second]);
  });
  return {
    issues: (value) => {
      const set = fields.filter((field) => value[field] !== undefined);
      return set.length <= 1
        ? []
        : set.slice(1).map((field) => ({
            path: [field],
            message: `set only one of ${fields.join(", ")}`,
          }));
    },
    json: {
      not: { anyOf: pairs.map((pair) => ({ required: [...pair] })) },
    },
  };
}

/**
 * An array that refuses a repeated item, with at most `max` items when given.
 * JSON Schema says `uniqueItems`.
 */
export function uniqueList<T extends z.ZodTypeAny>(
  item: T,
  label: string,
  max?: number,
): z.ZodEffects<z.ZodArray<T>> {
  const array = max === undefined ? z.array(item) : z.array(item).max(max);
  const refined = array.superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((entry, index) => {
      const key = JSON.stringify(entry);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `${label} lists ${key} twice`,
        });
      }
      seen.add(key);
    });
  });
  return withJsonSchema(refined, { uniqueItems: true });
}
