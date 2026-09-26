import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type FieldRule,
  type FieldTest,
  ruleIssues,
  ruleJson,
  toJsonSchema,
  uniqueArray,
  withJsonSchema,
  withRules,
} from "./json-schema";

const kindIsA: FieldTest = { field: "kind", is: "a" };
const kindIsNotA: FieldTest = { field: "kind", isNot: "a" };

const requireRule: FieldRule = {
  kind: "require",
  when: kindIsA,
  fields: ["name", "note"],
};
const forbidRule: FieldRule = {
  kind: "forbid",
  when: kindIsNotA,
  fields: ["name", "note"],
};
const maxLengthRule: FieldRule = {
  kind: "max_length",
  when: { field: "kind", isNot: "skill" },
  field: "description",
  max: 5,
};
const equalsRule: FieldRule = {
  kind: "equals",
  when: { field: "mode", isNot: "solo" },
  path: ["memory", "auto_merge"],
  value: false,
};

describe("ruleIssues", () => {
  it.each([
    ["require", requireRule, { kind: "b" }],
    ["forbid", forbidRule, { kind: "a", name: "x" }],
    ["max_length", maxLengthRule, { kind: "skill", description: "123456" }],
    ["equals", equalsRule, { mode: "solo", memory: { auto_merge: true } }],
  ])(
    "finds nothing under %s when its test does not hold",
    (_kind, rule, value) => {
      expect(ruleIssues(rule, value)).toEqual([]);
    },
  );

  it("reports each required field that is missing", () => {
    expect(ruleIssues(requireRule, { kind: "a", name: "x" })).toEqual([
      { path: ["note"], message: "note is required when kind is a" },
    ]);
    expect(
      ruleIssues(requireRule, { kind: "a", name: "x", note: "y" }),
    ).toEqual([]);
  });

  it("reports each forbidden field that is present", () => {
    expect(ruleIssues(forbidRule, { kind: "b", name: "x" })).toEqual([
      { path: ["name"], message: "name is not allowed when kind is not a" },
    ]);
    expect(ruleIssues(forbidRule, { kind: "b" })).toEqual([]);
  });

  it("treats an absent field as holding an isNot test", () => {
    expect(ruleIssues(forbidRule, { note: "y" })).toEqual([
      { path: ["note"], message: "note is not allowed when kind is not a" },
    ]);
  });

  it("reports a string longer than the maximum", () => {
    expect(
      ruleIssues(maxLengthRule, { kind: "fact", description: "123456" }),
    ).toEqual([
      {
        path: ["description"],
        message: "description is at most 5 characters when kind is not skill",
      },
    ]);
  });

  it.each([
    ["a string at the maximum", { kind: "fact", description: "12345" }],
    ["a value that is not a string", { kind: "fact", description: 42 }],
    ["an absent field", { kind: "fact" }],
  ])("accepts %s under max_length", (_name, value) => {
    expect(ruleIssues(maxLengthRule, value)).toEqual([]);
  });

  it("reports a nested value that differs from the one the rule names", () => {
    expect(
      ruleIssues(equalsRule, { mode: "team", memory: { auto_merge: true } }),
    ).toEqual([
      {
        path: ["memory", "auto_merge"],
        message: "memory.auto_merge must be false when mode is not solo",
      },
    ]);
  });

  it.each([
    ["the value it names", { mode: "team", memory: { auto_merge: false } }],
    ["an absent parent", { mode: "team" }],
    ["a null parent", { mode: "team", memory: null }],
    ["a parent that is not an object", { mode: "team", memory: "on" }],
    ["an absent leaf", { mode: "team", memory: {} }],
  ])("accepts %s under equals", (_name, value) => {
    expect(ruleIssues(equalsRule, value)).toEqual([]);
  });

  it("names a string value and an is test in an equals message", () => {
    const rule: FieldRule = {
      kind: "equals",
      when: { field: "a", is: "x" },
      path: ["b"],
      value: "y",
    };
    expect(ruleIssues(rule, { a: "x", b: "z" })).toEqual([
      { path: ["b"], message: "b must be y when a is x" },
    ]);
  });
});

describe("ruleJson", () => {
  const ifKindIsA = {
    properties: { kind: { const: "a" } },
    required: ["kind"],
  };

  it("publishes require as a required list", () => {
    expect(ruleJson(requireRule)).toEqual({
      if: ifKindIsA,
      then: { required: ["name", "note"] },
    });
  });

  it("publishes forbid as not anyOf required, under an isNot test", () => {
    expect(ruleJson(forbidRule)).toEqual({
      if: { not: ifKindIsA },
      then: {
        not: { anyOf: [{ required: ["name"] }, { required: ["note"] }] },
      },
    });
  });

  it("publishes max_length on the field's property", () => {
    expect(ruleJson(maxLengthRule)).toEqual({
      if: {
        not: {
          properties: { kind: { const: "skill" } },
          required: ["kind"],
        },
      },
      then: { properties: { description: { maxLength: 5 } } },
    });
  });

  it("publishes equals as a const at the end of nested properties", () => {
    expect(ruleJson(equalsRule)).toEqual({
      if: {
        not: {
          properties: { mode: { const: "solo" } },
          required: ["mode"],
        },
      },
      then: {
        properties: {
          memory: { properties: { auto_merge: { const: false } } },
        },
      },
    });
  });
});

describe("withRules", () => {
  const schema = withRules(
    z
      .object({
        kind: z.enum(["a", "b"]),
        name: z.string().optional(),
        note: z.string().optional(),
      })
      .strict(),
    [requireRule, forbidRule],
  );

  it("accepts a value every rule allows", () => {
    expect(
      schema.safeParse({ kind: "a", name: "x", note: "y" }).success,
    ).toBe(true);
    expect(schema.safeParse({ kind: "b" }).success).toBe(true);
  });

  it("reports a broken rule as a custom issue on the field it names", () => {
    const result = schema.safeParse({ kind: "a", name: "x" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: "custom",
        path: ["note"],
        message: "note is required when kind is a",
      }),
    ]);
  });

  it("reports every broken field", () => {
    const result = schema.safeParse({ kind: "b", name: "x", note: "y" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["name"],
      ["note"],
    ]);
  });

  it("publishes the rules as allOf beside the object's own keywords", () => {
    expect(toJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["a", "b"] },
        name: { type: "string" },
        note: { type: "string" },
      },
      required: ["kind"],
      additionalProperties: false,
      allOf: [ruleJson(requireRule), ruleJson(forbidRule)],
    });
  });
});

describe("uniqueArray", () => {
  it("accepts distinct items and an empty list when no minimum is set", () => {
    const tools = uniqueArray(z.string(), "tools");
    expect(tools.safeParse(["a", "b"]).success).toBe(true);
    expect(tools.safeParse([]).success).toBe(true);
  });

  it("reports a repeated item at its index", () => {
    const result = uniqueArray(z.string(), "tools").safeParse(["a", "b", "a"]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({ path: [2], message: 'tools lists "a" twice' }),
    ]);
  });

  it("compares object items by their JSON", () => {
    const repositories = uniqueArray(
      z.object({ url: z.string() }),
      "repositories",
    );
    const result = repositories.safeParse([{ url: "x" }, { url: "x" }]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe(
      'repositories lists {"url":"x"} twice',
    );
  });

  it("refuses a list shorter than the minimum", () => {
    const repos = uniqueArray(z.string(), "repos", 1);
    expect(repos.safeParse([]).success).toBe(false);
    expect(repos.safeParse(["a"]).success).toBe(true);
  });

  it("publishes uniqueItems, with minItems when a minimum is set", () => {
    expect(toJsonSchema(uniqueArray(z.string(), "tools"))).toEqual({
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    });
    expect(toJsonSchema(uniqueArray(z.string(), "repos", 1))).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      uniqueItems: true,
    });
  });
});

describe("toJsonSchema", () => {
  it.each([
    ["a plain string", z.string(), { type: "string" }],
    [
      "a minimum and maximum length",
      z.string().min(1).max(5),
      { type: "string", minLength: 1, maxLength: 5 },
    ],
    [
      "an exact length",
      z.string().length(3),
      { type: "string", minLength: 3, maxLength: 3 },
    ],
    [
      "one pattern",
      z.string().regex(/^a+$/),
      { type: "string", pattern: "^a+$" },
    ],
    [
      "two patterns",
      z.string().regex(/^a/).regex(/b$/),
      { type: "string", allOf: [{ pattern: "^a" }, { pattern: "b$" }] },
    ],
    [
      "a date-time",
      z.string().datetime({ offset: true }),
      { type: "string", format: "date-time" },
    ],
    ["a URL", z.string().url(), { type: "string", format: "uri" }],
  ])("converts %s", (_name, schema, expected) => {
    expect(toJsonSchema(schema)).toEqual(expected);
  });

  it.each([
    ["a plain number", z.number(), { type: "number" }],
    ["an integer", z.number().int(), { type: "integer" }],
    [
      "inclusive bounds",
      z.number().int().min(0).max(10),
      { type: "integer", minimum: 0, maximum: 10 },
    ],
    [
      "exclusive bounds",
      z.number().gt(0).lt(10),
      { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 },
    ],
  ])("converts %s", (_name, schema, expected) => {
    expect(toJsonSchema(schema)).toEqual(expected);
  });

  it.each([
    ["a boolean", z.boolean(), { type: "boolean" }],
    [
      "an enum",
      z.enum(["must", "should"]),
      { type: "string", enum: ["must", "should"] },
    ],
    ["a literal", z.literal("agent/v1"), { const: "agent/v1" }],
    ["an unknown", z.unknown(), {}],
    [
      "an optional value as its inner type",
      z.string().optional(),
      { type: "string" },
    ],
    [
      "a refinement as its inner type",
      z.string().refine((value) => value !== "x"),
      { type: "string" },
    ],
    [
      "a nullable value",
      z.string().nullable(),
      { anyOf: [{ type: "string" }, { type: "null" }] },
    ],
    [
      "a union",
      z.union([z.string(), z.number()]),
      { anyOf: [{ type: "string" }, { type: "number" }] },
    ],
    [
      "a record",
      z.record(z.string().min(1), z.number()),
      {
        type: "object",
        propertyNames: { type: "string", minLength: 1 },
        additionalProperties: { type: "number" },
      },
    ],
  ])("converts %s", (_name, schema, expected) => {
    expect(toJsonSchema(schema)).toEqual(expected);
  });

  it.each([
    [
      "with no bounds",
      z.array(z.string()),
      { type: "array", items: { type: "string" } },
    ],
    [
      "with a minimum and a maximum",
      z.array(z.string()).min(1).max(3),
      { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
    ],
    [
      "with an exact length",
      z.array(z.string()).length(2),
      { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
    ],
  ])("converts an array %s", (_name, schema, expected) => {
    expect(toJsonSchema(schema)).toEqual(expected);
  });

  it("lists the required keys of a strict object and refuses others", () => {
    const schema = z
      .object({ name: z.string(), note: z.string().optional() })
      .strict();
    expect(toJsonSchema(schema)).toEqual({
      type: "object",
      properties: { name: { type: "string" }, note: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("leaves out required and additionalProperties when neither applies", () => {
    expect(toJsonSchema(z.object({ note: z.string().optional() }))).toEqual({
      type: "object",
      properties: { note: { type: "string" } },
    });
  });

  it("adds the description a schema carries", () => {
    expect(toJsonSchema(z.string().describe("A name"))).toEqual({
      type: "string",
      description: "A name",
    });
  });

  it("adds extra keywords to a plain schema and returns that schema", () => {
    const base = z.string();
    const withExtra = withJsonSchema(base, { not: { enum: ["settings"] } });
    expect(withExtra).toBe(base);
    expect(toJsonSchema(withExtra)).toEqual({
      type: "string",
      not: { enum: ["settings"] },
    });
  });

  it("keeps a refinement's extra keywords after .describe()", () => {
    const refined = withJsonSchema(
      z.array(z.string()).refine(() => true),
      { uniqueItems: true },
    );
    expect(toJsonSchema(refined.describe("Items"))).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Items",
      uniqueItems: true,
    });
  });

  it("refuses a string check it cannot publish", () => {
    expect(() => toJsonSchema(z.string().email())).toThrow(
      'json-schema.ts cannot publish the string check "email"',
    );
  });

  it("refuses a number check it cannot publish", () => {
    expect(() => toJsonSchema(z.number().multipleOf(2))).toThrow(
      'json-schema.ts cannot publish the number check "multipleOf"',
    );
  });

  it("refuses a zod type it cannot publish, even inside an object", () => {
    expect(() => toJsonSchema(z.date())).toThrow(
      "json-schema.ts cannot publish a ZodDate",
    );
    expect(() => toJsonSchema(z.object({ at: z.date() }))).toThrow(TypeError);
  });
});
