// validate.ts: the inputSchema check that runs before a call is shaped and sent.
import { describe, expect, it } from "vitest";
import { MAX_ISSUES, resolveRef, validateInput } from "./validate";

function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 0; level < levels; level += 1) value = { c: value };
  return value;
}

describe("validateInput", () => {
  it("returns no issues for conforming arguments", () => {
    const schema = {
      type: "object",
      properties: { amount: { type: "integer", minimum: 1 } },
      required: ["amount"],
    };
    expect(validateInput(schema, { amount: 5 })).toEqual([]);
  });

  it("passes anything under true or a schema that is not an object, and nothing under false", () => {
    expect(validateInput(true, 1)).toEqual([]);
    expect(validateInput(undefined, 1)).toEqual([]);
    expect(validateInput(false, 1)).toEqual(["input is not allowed."]);
  });

  describe("type", () => {
    it("names each expected type", () => {
      expect(validateInput({ type: "string" }, 1)).toEqual(["input must be a string."]);
      expect(validateInput({ type: ["string", "null"] }, 1)).toEqual(["input must be a string or null."]);
      expect(validateInput({ type: "integer" }, 1.5)).toEqual(["input must be an integer."]);
      expect(validateInput({ type: "boolean" }, "true")).toEqual(["input must be a boolean."]);
      expect(validateInput({ type: "object" }, [])).toEqual(["input must be an object."]);
      expect(validateInput({ type: "array" }, {})).toEqual(["input must be an array."]);
      expect(validateInput({ type: "null" }, 0)).toEqual(["input must be null."]);
    });

    it("accepts each matching type", () => {
      expect(validateInput({ type: "string" }, "a")).toEqual([]);
      expect(validateInput({ type: "number" }, 1.5)).toEqual([]);
      expect(validateInput({ type: "integer" }, 2)).toEqual([]);
      expect(validateInput({ type: "boolean" }, false)).toEqual([]);
      expect(validateInput({ type: "object" }, {})).toEqual([]);
      expect(validateInput({ type: "array" }, [])).toEqual([]);
      expect(validateInput({ type: "null" }, null)).toEqual([]);
    });

    it("refuses a number that is not finite", () => {
      expect(validateInput({ type: "number" }, Number.POSITIVE_INFINITY)).toEqual(["input must be a number."]);
    });

    it("passes a type name it does not know", () => {
      expect(validateInput({ type: "widget" }, 1)).toEqual([]);
      expect(validateInput({ type: ["widget", 3] }, 1)).toEqual([]);
    });

    it("stops at a type issue, so the value's other bounds are not reported", () => {
      expect(validateInput({ type: "string", minimum: 10 }, 5)).toEqual(["input must be a string."]);
    });

    it("keeps the $ref issues found before a type issue", () => {
      const schema = { $defs: { positive: { minimum: 1 } }, $ref: "#/$defs/positive", type: "string" };
      expect(validateInput(schema, 0)).toEqual(["input must be at least 1.", "input must be a string."]);
    });

    it("accepts null for an OpenAPI 3.0 nullable schema", () => {
      expect(validateInput({ type: "string", nullable: true }, null)).toEqual([]);
      expect(validateInput({ type: "string" }, null)).toEqual(["input must be a string."]);
    });
  });

  describe("enum and const", () => {
    it("lists the allowed values", () => {
      expect(validateInput({ enum: ["a", "b"] }, "c")).toEqual(['input must be one of "a", "b".']);
      expect(validateInput({ enum: [{ a: 1 }] }, { a: 1 })).toEqual([]);
    });

    it("shows 10 values and counts the rest", () => {
      const options = Array.from({ length: 12 }, (_, index) => index);
      expect(validateInput({ enum: options }, 99)).toEqual(["input must be one of 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, and 2 more."]);
    });

    it("writes a value JSON cannot hold as text", () => {
      expect(validateInput({ enum: [undefined] }, "x")).toEqual(["input must be one of undefined."]);
    });

    it("compares const by value, null included", () => {
      expect(validateInput({ const: "x" }, "y")).toEqual(['input must be "x".']);
      expect(validateInput({ const: null }, null)).toEqual([]);
      expect(validateInput({ const: { a: [1] } }, { a: [1] })).toEqual([]);
    });
  });

  describe("strings", () => {
    it("checks length in code points", () => {
      expect(validateInput({ minLength: 2 }, "a")).toEqual(["input must be at least 2 characters long."]);
      expect(validateInput({ minLength: 1 }, "")).toEqual(["input must be at least 1 character long."]);
      expect(validateInput({ maxLength: 1 }, "ab")).toEqual(["input must be at most 1 character long."]);
      expect(validateInput({ maxLength: 3 }, "abcd")).toEqual(["input must be at most 3 characters long."]);
      expect(validateInput({ maxLength: 1 }, "\u{1F600}")).toEqual([]);
    });

    it("checks a pattern", () => {
      expect(validateInput({ pattern: "^[a-z]+$" }, "A1")).toEqual(["input must match the pattern ^[a-z]+$."]);
      expect(validateInput({ pattern: "^[a-z]+$" }, "ok")).toEqual([]);
    });

    it("reads a pattern that is valid only without the u flag", () => {
      expect(validateInput({ pattern: "^\\a$" }, "a")).toEqual([]);
      expect(validateInput({ pattern: "^\\a$" }, "b")).toEqual(["input must match the pattern ^\\a$."]);
    });

    it("passes a pattern that is not a regular expression", () => {
      expect(validateInput({ pattern: "[" }, "anything")).toEqual([]);
    });
  });

  describe("numbers", () => {
    it("checks inclusive bounds", () => {
      expect(validateInput({ minimum: 1 }, 0)).toEqual(["input must be at least 1."]);
      expect(validateInput({ minimum: 1 }, 1)).toEqual([]);
      expect(validateInput({ maximum: 10 }, 11)).toEqual(["input must be at most 10."]);
      expect(validateInput({ maximum: 10 }, 10)).toEqual([]);
    });

    it("checks draft 4 exclusive flags", () => {
      expect(validateInput({ minimum: 1, exclusiveMinimum: true }, 1)).toEqual(["input must be greater than 1."]);
      expect(validateInput({ minimum: 1, exclusiveMinimum: true }, 2)).toEqual([]);
      expect(validateInput({ maximum: 10, exclusiveMaximum: true }, 10)).toEqual(["input must be less than 10."]);
      expect(validateInput({ maximum: 10, exclusiveMaximum: true }, 9)).toEqual([]);
    });

    it("checks numeric exclusive bounds", () => {
      expect(validateInput({ exclusiveMinimum: 0 }, 0)).toEqual(["input must be greater than 0."]);
      expect(validateInput({ exclusiveMinimum: 0 }, 1)).toEqual([]);
      expect(validateInput({ exclusiveMaximum: 5 }, 5)).toEqual(["input must be less than 5."]);
      expect(validateInput({ exclusiveMaximum: 5 }, 4)).toEqual([]);
    });

    it("checks multipleOf with room for decimal rounding", () => {
      expect(validateInput({ multipleOf: 0.01 }, 0.3)).toEqual([]);
      expect(validateInput({ multipleOf: 0.01 }, 0.305)).toEqual(["input must be a multiple of 0.01."]);
      expect(validateInput({ multipleOf: 0 }, 3)).toEqual([]);
    });
  });

  describe("arrays", () => {
    it("checks the item count", () => {
      expect(validateInput({ minItems: 2 }, [1])).toEqual(["input must have at least 2 items."]);
      expect(validateInput({ minItems: 1 }, [])).toEqual(["input must have at least 1 item."]);
      expect(validateInput({ maxItems: 1 }, [1, 2])).toEqual(["input must have at most 1 item."]);
      expect(validateInput({ minItems: 1, maxItems: 2 }, [1])).toEqual([]);
    });

    it("names the first repeated item, comparing objects by value", () => {
      expect(validateInput({ uniqueItems: true }, [1, { a: 1, b: [2] }, { b: [2], a: 1 }])).toEqual([
        "input[2] repeats an earlier item, and input must have unique items.",
      ]);
      expect(validateInput({ uniqueItems: true }, [1, "1", [1], { a: 1 }])).toEqual([]);
      expect(validateInput({ uniqueItems: true }, [undefined, undefined])).toEqual([
        "input[1] repeats an earlier item, and input must have unique items.",
      ]);
    });

    it("checks each item against items", () => {
      expect(validateInput({ items: { type: "integer" } }, [1, "x"])).toEqual(["input[1] must be an integer."]);
    });

    it("checks prefixItems, then items for the rest", () => {
      const schema = { prefixItems: [{ type: "string" }], items: { type: "integer" } };
      expect(validateInput(schema, ["a", 1, "b"])).toEqual(["input[2] must be an integer."]);
      expect(validateInput(schema, [1])).toEqual(["input[0] must be a string."]);
      expect(validateInput({ prefixItems: [{ type: "string" }] }, ["a", 5])).toEqual([]);
    });

    it("checks a tuple items array, then additionalItems", () => {
      const schema = { items: [{ type: "string" }], additionalItems: false };
      expect(validateInput(schema, ["a", 1])).toEqual(["input[1] is not allowed."]);
      expect(validateInput({ items: [{ type: "string" }] }, ["a", 1])).toEqual([]);
    });

    it("checks contains", () => {
      expect(validateInput({ contains: { type: "string" } }, [1, 2])).toEqual([
        "input must contain an item that matches its contains schema.",
      ]);
      expect(validateInput({ contains: { type: "string" } }, [1, "a"])).toEqual([]);
    });
  });

  describe("objects", () => {
    it("names each missing required property, and counts undefined as missing", () => {
      expect(validateInput({ required: ["customer_id", "a b", 5] }, {})).toEqual([
        "input.customer_id is required.",
        'input["a b"] is required.',
      ]);
      expect(validateInput({ required: ["x"] }, { x: undefined })).toEqual(["input.x is required."]);
    });

    it("checks the property count", () => {
      expect(validateInput({ minProperties: 1 }, {})).toEqual(["input must have at least 1 property."]);
      expect(validateInput({ minProperties: 2 }, { a: 1 })).toEqual(["input must have at least 2 properties."]);
      expect(validateInput({ maxProperties: 1 }, { a: 1, b: 2 })).toEqual(["input must have at most 1 property."]);
      expect(validateInput({ maxProperties: 2 }, { a: 1, b: 2, c: 3 })).toEqual(["input must have at most 2 properties."]);
    });

    it("checks nested properties with their paths", () => {
      const schema = { properties: { customer: { properties: { id: { type: "string" } } } } };
      expect(validateInput(schema, { customer: { id: 7 } })).toEqual(["input.customer.id must be a string."]);
    });

    it("writes a key that is not an identifier in brackets", () => {
      const schema = { properties: { "1a": { type: "string" }, "a-b": { type: "string" } } };
      expect(validateInput(schema, { "1a": 1, "a-b": 2 })).toEqual([
        'input["1a"] must be a string.',
        "input.a-b must be a string.",
      ]);
    });

    it("checks patternProperties and refuses other keys when additionalProperties is false", () => {
      const schema = { patternProperties: { "^x_": { type: "integer" }, "[": {} }, additionalProperties: false };
      expect(validateInput(schema, { x_a: "s", y: 1 })).toEqual([
        "input.x_a must be an integer.",
        "input.y is not an allowed property.",
      ]);
    });

    it("checks other keys against an additionalProperties schema", () => {
      const schema = { properties: { a: {} }, additionalProperties: { type: "string" } };
      expect(validateInput(schema, { a: 1, b: 2 })).toEqual(["input.b must be a string."]);
    });

    it("allows any other key when additionalProperties is absent", () => {
      expect(validateInput({ properties: { a: {} } }, { b: 2 })).toEqual([]);
    });
  });

  describe("combinators", () => {
    it("reports every allOf issue", () => {
      expect(validateInput({ allOf: [{ minimum: 1 }, { maximum: 0 }] }, 0.5)).toEqual([
        "input must be at least 1.",
        "input must be at most 0.",
      ]);
    });

    it("checks anyOf", () => {
      const schema = { anyOf: [{ type: "string" }, { type: "integer" }] };
      expect(validateInput(schema, 1.5)).toEqual(["input must match at least one of its anyOf schemas."]);
      expect(validateInput(schema, "a")).toEqual([]);
    });

    it("counts oneOf matches", () => {
      const schema = { oneOf: [{ type: "number" }, { type: "integer" }] };
      expect(validateInput(schema, 1)).toEqual(["input must match exactly one of its oneOf schemas, and it matches 2."]);
      expect(validateInput(schema, "a")).toEqual(["input must match exactly one of its oneOf schemas, and it matches 0."]);
      expect(validateInput(schema, 1.5)).toEqual([]);
    });

    it("checks not", () => {
      expect(validateInput({ not: { type: "string" } }, "a")).toEqual(["input must not match its not schema."]);
      expect(validateInput({ not: { type: "string" } }, 1)).toEqual([]);
    });

    it("takes then when if matches and else when it does not", () => {
      const schema = {
        if: { properties: { kind: { const: "card" } } },
        then: { required: ["last4"] },
        else: { required: ["iban"] },
      };
      expect(validateInput(schema, { kind: "card" })).toEqual(["input.last4 is required."]);
      expect(validateInput(schema, { kind: "bank" })).toEqual(["input.iban is required."]);
      expect(validateInput({ if: { type: "string" } }, "a")).toEqual([]);
    });
  });

  describe("$ref", () => {
    it("checks a local definition", () => {
      const schema = {
        $defs: { money: { type: "integer", minimum: 1 } },
        properties: { amount: { $ref: "#/$defs/money" } },
      };
      expect(validateInput(schema, { amount: 0 })).toEqual(["input.amount must be at least 1."]);
    });

    it("passes a reference it cannot resolve", () => {
      expect(validateInput({ $ref: "#/$defs/missing" }, 1)).toEqual([]);
      expect(validateInput({ $ref: "https://example.com/schema.json" }, 1)).toEqual([]);
    });

    it("follows a recursive reference", () => {
      const schema = { type: "object", properties: { child: { $ref: "#" } }, additionalProperties: false };
      expect(validateInput(schema, { child: { child: { extra: 1 } } })).toEqual([
        "input.child.child.extra is not an allowed property.",
      ]);
    });

    it("stops checking past 64 levels of nesting", () => {
      const schema = { properties: { c: { $ref: "#" } }, required: ["c"] };
      expect(validateInput(schema, nested(3))).toEqual(["input.c.c.c.c is required."]);
      expect(validateInput(schema, nested(40))).toEqual([]);
    });

    it("bounds the work of a schema that branches at every level", () => {
      // Without the step budget this schema visits 2^32 nodes and the test times out.
      const schema = { oneOf: [{ $ref: "#" }, { $ref: "#" }] };
      expect(validateInput(schema, 1).length).toBeLessThanOrEqual(MAX_ISSUES);
    });
  });

  it("reports at most 10 issues", () => {
    const required = Array.from({ length: 12 }, (_, index) => `field_${index}`);
    const issues = validateInput({ required }, {});
    expect(issues).toHaveLength(MAX_ISSUES);
    expect(issues[0]).toBe("input.field_0 is required.");
  });
});

describe("resolveRef", () => {
  const root = {
    $defs: { "a/b": 1, "a~b": 2, "a b": 3, n: 4 },
    list: ["zero", "one"],
  };

  it("resolves the root and JSON pointers", () => {
    expect(resolveRef(root, "#")).toBe(root);
    expect(resolveRef(root, "#/$defs/a~1b")).toBe(1);
    expect(resolveRef(root, "#/$defs/a~0b")).toBe(2);
    expect(resolveRef(root, "#/$defs/a%20b")).toBe(3);
    expect(resolveRef(root, "#/list/1")).toBe("one");
  });

  it("resolves nothing for a pointer that leads nowhere", () => {
    expect(resolveRef(root, "other.json#/a")).toBeUndefined();
    expect(resolveRef(root, "#/missing")).toBeUndefined();
    expect(resolveRef(root, "#/$defs/toString")).toBeUndefined();
    expect(resolveRef(root, "#/$defs/n/x")).toBeUndefined();
    expect(resolveRef(root, "#/list/5")).toBeUndefined();
    expect(resolveRef(root, "#/list/-1")).toBeUndefined();
    expect(resolveRef(root, "#/list/x")).toBeUndefined();
    expect(resolveRef(root, "#/$defs/%E0%A4%A")).toBeUndefined();
  });
});
