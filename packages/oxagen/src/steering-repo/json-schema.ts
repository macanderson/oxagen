// json-schema.ts: turns the zod schemas in this folder into JSON Schema
// (draft 2020-12), and states the cross-field rules once for both.
//
// A zod refinement is a function, so no converter can read it. The rules the
// steering repo needs (a constraint carries `effect`, a skill carries `name`
// and `description`, and the like) are written as data here instead. The
// same data drives the zod check and the JSON Schema `allOf`, so an editor
// that reads the published schema refuses what the zod schema refuses.
//
// The converter covers the zod types these schemas use and throws on any
// other, so a new type cannot reach a published schema half converted.
import { z } from "zod";

export type JsonSchema = { [keyword: string]: unknown };

const extraKeywords = new WeakMap<object, JsonSchema>();

/**
 * The key a schema's extra keywords are stored under. zod's `.describe()`
 * returns a copy, so a refinement is keyed by its effect, which the copy
 * shares, and every other schema by itself.
 */
function keywordsKey(schema: z.ZodTypeAny): object {
  return schema instanceof z.ZodEffects
    ? (schema._def.effect as object)
    : schema;
}

/**
 * Add JSON Schema keywords to one zod schema's output, for a constraint zod
 * checks in a refinement: `uniqueItems`, a reserved-value `not`, or a `$ref`.
 * Returns the schema it was given.
 */
export function withJsonSchema<T extends z.ZodTypeAny>(
  schema: T,
  keywords: JsonSchema,
): T {
  extraKeywords.set(keywordsKey(schema), keywords);
  return schema;
}

// ── Cross-field rules ────────────────────────────────────────────────────────

/** A test on one field of the object a rule belongs to. An absent field is never equal. */
export type FieldTest =
  | { field: string; is: string }
  | { field: string; isNot: string };

/** One cross-field rule, readable by zod and by JSON Schema. */
export type FieldRule =
  | { kind: "require"; when: FieldTest; fields: readonly string[] }
  | { kind: "forbid"; when: FieldTest; fields: readonly string[] }
  | { kind: "max_length"; when: FieldTest; field: string; max: number }
  | {
      kind: "equals";
      when: FieldTest;
      path: readonly string[];
      value: boolean | string;
    };

function holds(test: FieldTest, value: Record<string, unknown>): boolean {
  return "is" in test
    ? value[test.field] === test.is
    : value[test.field] !== test.isNot;
}

function describeTest(test: FieldTest): string {
  return "is" in test
    ? `${test.field} is ${test.is}`
    : `${test.field} is not ${test.isNot}`;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

interface RuleIssue {
  path: (string | number)[];
  message: string;
}

/** What one rule finds wrong with a value that passed the object's own schema. */
export function ruleIssues(
  rule: FieldRule,
  value: Record<string, unknown>,
): RuleIssue[] {
  if (!holds(rule.when, value)) return [];
  const when = describeTest(rule.when);
  switch (rule.kind) {
    case "require":
      return rule.fields
        .filter((field) => value[field] === undefined)
        .map((field) => ({
          path: [field],
          message: `${field} is required when ${when}`,
        }));
    case "forbid":
      return rule.fields
        .filter((field) => value[field] !== undefined)
        .map((field) => ({
          path: [field],
          message: `${field} is not allowed when ${when}`,
        }));
    case "max_length": {
      const text = value[rule.field];
      return typeof text === "string" && text.length > rule.max
        ? [
            {
              path: [rule.field],
              message: `${rule.field} is at most ${rule.max} characters when ${when}`,
            },
          ]
        : [];
    }
    case "equals": {
      const found = valueAt(value, rule.path);
      return found === undefined || found === rule.value
        ? []
        : [
            {
              path: [...rule.path],
              message: `${rule.path.join(".")} must be ${String(rule.value)} when ${when}`,
            },
          ];
    }
  }
}

function testJson(test: FieldTest): JsonSchema {
  const matches: JsonSchema = {
    properties: { [test.field]: { const: "is" in test ? test.is : test.isNot } },
    required: [test.field],
  };
  return "is" in test ? matches : { not: matches };
}

function nested(path: readonly string[], leaf: JsonSchema): JsonSchema {
  return path.reduceRight<JsonSchema>(
    (inner, key) => ({ properties: { [key]: inner } }),
    leaf,
  );
}

/** The `if`/`then` pair one rule publishes. */
export function ruleJson(rule: FieldRule): JsonSchema {
  const condition = testJson(rule.when);
  switch (rule.kind) {
    case "require":
      return { if: condition, then: { required: [...rule.fields] } };
    case "forbid":
      return {
        if: condition,
        then: {
          not: { anyOf: rule.fields.map((field) => ({ required: [field] })) },
        },
      };
    case "max_length":
      return {
        if: condition,
        then: nested([rule.field], { maxLength: rule.max }),
      };
    case "equals":
      return { if: condition, then: nested(rule.path, { const: rule.value }) };
  }
}

/**
 * An object schema with cross-field rules. zod reports each broken rule as
 * an issue on the field it names, and the JSON Schema carries the rules as
 * `allOf` of `if`/`then` pairs.
 */
export function withRules<T extends z.AnyZodObject>(
  schema: T,
  rules: readonly FieldRule[],
): z.ZodEffects<T> {
  const refined = schema.superRefine((value, ctx) => {
    for (const rule of rules) {
      for (const issue of ruleIssues(rule, value as Record<string, unknown>)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
      }
    }
  });
  return withJsonSchema(refined, { allOf: rules.map(ruleJson) });
}

/**
 * An array that refuses a repeated item, with at least `min` items. JSON
 * Schema says `uniqueItems`.
 */
export function uniqueArray<T extends z.ZodTypeAny>(
  item: T,
  label: string,
  min = 0,
): z.ZodEffects<z.ZodArray<T>> {
  const array = min > 0 ? z.array(item).min(min) : z.array(item);
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

// ── The converter ────────────────────────────────────────────────────────────

function stringJson(schema: z.ZodString): JsonSchema {
  const out: JsonSchema = { type: "string" };
  const patterns: string[] = [];
  for (const check of schema._def.checks) {
    switch (check.kind) {
      case "min":
        out.minLength = check.value;
        break;
      case "max":
        out.maxLength = check.value;
        break;
      case "length":
        out.minLength = check.value;
        out.maxLength = check.value;
        break;
      case "regex":
        patterns.push(check.regex.source);
        break;
      case "datetime":
        out.format = "date-time";
        break;
      case "url":
        out.format = "uri";
        break;
      default:
        throw new TypeError(
          `json-schema.ts cannot publish the string check "${check.kind}"`,
        );
    }
  }
  if (patterns.length === 1) out.pattern = patterns[0];
  if (patterns.length > 1) out.allOf = patterns.map((pattern) => ({ pattern }));
  return out;
}

function numberJson(schema: z.ZodNumber): JsonSchema {
  const out: JsonSchema = { type: "number" };
  for (const check of schema._def.checks) {
    switch (check.kind) {
      case "int":
        out.type = "integer";
        break;
      case "min":
        out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
        break;
      case "max":
        out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
        break;
      default:
        throw new TypeError(
          `json-schema.ts cannot publish the number check "${check.kind}"`,
        );
    }
  }
  return out;
}

function objectJson(schema: z.AnyZodObject): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(
    schema.shape as Record<string, z.ZodTypeAny>,
  )) {
    properties[key] = convert(child);
    if (!child.isOptional()) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out.required = required;
  if (schema._def.unknownKeys === "strict") out.additionalProperties = false;
  return out;
}

function arrayJson(schema: z.ZodArray<z.ZodTypeAny>): JsonSchema {
  const out: JsonSchema = { type: "array", items: convert(schema.element) };
  const { exactLength, minLength, maxLength } = schema._def;
  if (exactLength) {
    out.minItems = exactLength.value;
    out.maxItems = exactLength.value;
  }
  if (minLength) out.minItems = minLength.value;
  if (maxLength) out.maxItems = maxLength.value;
  return out;
}

// `instanceof` narrows a zod class to its `any` type parameters, so each
// branch states the parameters it reads.
function typeJson(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional) {
    return convert((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
  }
  if (schema instanceof z.ZodEffects) {
    return convert((schema as z.ZodEffects<z.ZodTypeAny>).innerType());
  }
  if (schema instanceof z.ZodNullable) {
    const inner = (schema as z.ZodNullable<z.ZodTypeAny>).unwrap();
    return { anyOf: [convert(inner), { type: "null" }] };
  }
  if (schema instanceof z.ZodObject) {
    return objectJson(schema as z.AnyZodObject);
  }
  if (schema instanceof z.ZodString) return stringJson(schema);
  if (schema instanceof z.ZodNumber) return numberJson(schema);
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...(schema.options as string[])] };
  }
  if (schema instanceof z.ZodLiteral) return { const: schema.value as unknown };
  if (schema instanceof z.ZodArray) {
    return arrayJson(schema as z.ZodArray<z.ZodTypeAny>);
  }
  if (schema instanceof z.ZodUnion) {
    return {
      anyOf: (schema.options as z.ZodTypeAny[]).map((option) =>
        convert(option),
      ),
    };
  }
  if (schema instanceof z.ZodRecord) {
    return {
      type: "object",
      propertyNames: convert(schema.keySchema as z.ZodTypeAny),
      additionalProperties: convert(schema.valueSchema as z.ZodTypeAny),
    };
  }
  if (schema instanceof z.ZodUnknown) return {};
  const { typeName } = schema._def as { typeName?: string };
  throw new TypeError(`json-schema.ts cannot publish a ${String(typeName)}`);
}

function convert(schema: z.ZodTypeAny): JsonSchema {
  const out = typeJson(schema);
  if (schema.description !== undefined) out.description = schema.description;
  const extra = extraKeywords.get(keywordsKey(schema));
  return extra === undefined ? out : { ...out, ...extra };
}

/** The JSON Schema for one zod schema, without `$schema`, `$id`, or `title`. */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}
