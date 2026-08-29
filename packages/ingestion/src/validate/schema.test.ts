/**
 * Unit tests for the shared schema-registry validator.
 *
 * Covers: required-property enforcement, type checks, enum (oneOf), numeric +
 * string constraints, the conformance-score math against its named-constant
 * weights, relationship endpoint constraints, and all three enforcement modes'
 * outcome classification.
 */

import { describe, it, expect } from "vitest";
import {
  validateNodeAgainstSchema,
  validateRelationshipAgainstSchema,
  MISSING_REQUIRED_WEIGHT,
  TYPE_ERROR_WEIGHT,
  MISSING_OPTIONAL_WEIGHT,
  type PinnedSchema,
  type PinnedProperty,
} from "./schema";

function prop(over: Partial<PinnedProperty> & { key: string }): PinnedProperty {
  return {
    dataType: "string",
    required: false,
    description: null,
    enumValues: null,
    itemType: null,
    constraints: {},
    example: null,
    ...over,
  };
}

function schema(over: Partial<PinnedSchema> = {}): PinnedSchema {
  return {
    registryId: "scr_1",
    versionId: "scv_1",
    versionNumber: 1,
    enforcementMode: "lenient",
    conformanceFloor: 0.5,
    labels: [],
    relationshipTypes: [],
    ...over,
  };
}

describe("validateNodeAgainstSchema — unknown label pass-through", () => {
  it("returns perfect conformance for a label not in the active vocabulary", () => {
    const result = validateNodeAgainstSchema(
      { label: "Unmodeled", properties: { anything: 1 } },
      schema(),
    );
    expect(result.valid).toBe(true);
    expect(result.conformanceScore).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(result.outcome).toBe("accepted");
  });
});

describe("validateNodeAgainstSchema — required properties", () => {
  const s = schema({
    labels: [
      {
        schemaName: "crm",
        name: "Customer",
        displayName: "Customer",
        description: null,
        naturalKeyProps: ["email"],
        properties: [
          prop({ key: "email", dataType: "email", required: true }),
          prop({ key: "name", dataType: "string", required: true }),
        ],
      },
    ],
  });

  it("flags a missing required property with code=required", () => {
    const result = validateNodeAgainstSchema(
      { label: "Customer", properties: { email: "a@b.com" } },
      s,
    );
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toEqual(["name"]);
    expect(result.errors).toEqual([
      { field: "name", message: "name is required", code: "required" },
    ]);
  });

  it("accepts a fully-populated node", () => {
    const result = validateNodeAgainstSchema(
      { label: "Customer", properties: { email: "a@b.com", name: "Acme" } },
      s,
    );
    expect(result.valid).toBe(true);
    expect(result.conformanceScore).toBe(1);
    expect(result.missingRequired).toEqual([]);
  });
});

describe("validateNodeAgainstSchema — type checks", () => {
  const s = schema({
    labels: [
      {
        schemaName: "crm",
        name: "Deal",
        displayName: "Deal",
        description: null,
        naturalKeyProps: [],
        properties: [
          prop({ key: "amount", dataType: "integer", required: true }),
          prop({ key: "active", dataType: "boolean", required: false }),
          prop({ key: "site", dataType: "url", required: false }),
        ],
      },
    ],
  });

  it("rejects a non-integer for an integer field", () => {
    const result = validateNodeAgainstSchema(
      { label: "Deal", properties: { amount: 4.2 } },
      s,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("type");
    expect(result.errors[0]?.field).toBe("amount");
  });

  it("rejects a non-boolean for a boolean field", () => {
    const result = validateNodeAgainstSchema(
      { label: "Deal", properties: { amount: 5, active: "yes" } },
      s,
    );
    expect(
      result.errors.some((e) => e.field === "active" && e.code === "type"),
    ).toBe(true);
  });

  it("rejects a malformed url", () => {
    const result = validateNodeAgainstSchema(
      { label: "Deal", properties: { amount: 5, site: "not a url" } },
      s,
    );
    expect(
      result.errors.some((e) => e.field === "site" && e.code === "type"),
    ).toBe(true);
  });

  it("accepts a valid url + integer", () => {
    const result = validateNodeAgainstSchema(
      { label: "Deal", properties: { amount: 5, site: "https://acme.com" } },
      s,
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateNodeAgainstSchema — enum + constraints", () => {
  const s = schema({
    labels: [
      {
        schemaName: "crm",
        name: "Ticket",
        displayName: "Ticket",
        description: null,
        naturalKeyProps: [],
        properties: [
          prop({
            key: "status",
            dataType: "enum",
            required: true,
            enumValues: ["open", "closed"],
          }),
          prop({
            key: "priority",
            dataType: "integer",
            required: false,
            constraints: { min: 1, max: 5 },
          }),
          prop({
            key: "code",
            dataType: "string",
            required: false,
            constraints: { minLength: 3, pattern: "^[A-Z]+$" },
          }),
        ],
      },
    ],
  });

  it("rejects an enum value outside the allowed set (code=oneOf)", () => {
    const result = validateNodeAgainstSchema(
      { label: "Ticket", properties: { status: "archived" } },
      s,
    );
    expect(
      result.errors.some((e) => e.field === "status" && e.code === "oneOf"),
    ).toBe(true);
  });

  it("enforces numeric min/max", () => {
    const result = validateNodeAgainstSchema(
      { label: "Ticket", properties: { status: "open", priority: 9 } },
      s,
    );
    expect(
      result.errors.some((e) => e.field === "priority" && e.code === "max"),
    ).toBe(true);
  });

  it("enforces string minLength + pattern", () => {
    const result = validateNodeAgainstSchema(
      { label: "Ticket", properties: { status: "open", code: "ab" } },
      s,
    );
    expect(
      result.errors.some((e) => e.field === "code" && e.code === "minLength"),
    ).toBe(true);
  });
});

describe("conformance score math (named-constant weights)", () => {
  it("a single missing required over 2 props = 1 − MISSING_REQUIRED_WEIGHT/2", () => {
    const s = schema({
      labels: [
        {
          schemaName: "s",
          name: "L",
          displayName: "L",
          description: null,
          naturalKeyProps: [],
          properties: [
            prop({ key: "a", required: true }),
            prop({ key: "b", required: true }),
          ],
        },
      ],
    });
    const result = validateNodeAgainstSchema(
      { label: "L", properties: { a: "x" } },
      s,
    );
    expect(result.conformanceScore).toBeCloseTo(
      1 - MISSING_REQUIRED_WEIGHT / 2,
      6,
    );
  });

  it("a single type error over 1 prop = 1 − TYPE_ERROR_WEIGHT/1", () => {
    const s = schema({
      labels: [
        {
          schemaName: "s",
          name: "L",
          displayName: "L",
          description: null,
          naturalKeyProps: [],
          properties: [
            prop({ key: "n", dataType: "integer", required: false }),
          ],
        },
      ],
    });
    const result = validateNodeAgainstSchema(
      { label: "L", properties: { n: "nope" } },
      s,
    );
    expect(result.conformanceScore).toBeCloseTo(1 - TYPE_ERROR_WEIGHT / 1, 6);
  });

  it("a missing optional uses the lighter MISSING_OPTIONAL_WEIGHT", () => {
    const s = schema({
      labels: [
        {
          schemaName: "s",
          name: "L",
          displayName: "L",
          description: null,
          naturalKeyProps: [],
          properties: [
            prop({ key: "req", required: true }),
            prop({ key: "opt", required: false }),
          ],
        },
      ],
    });
    const result = validateNodeAgainstSchema(
      { label: "L", properties: { req: "x" } },
      s,
    );
    expect(result.conformanceScore).toBeCloseTo(
      1 - MISSING_OPTIONAL_WEIGHT / 2,
      6,
    );
    expect(result.valid).toBe(true); // optional miss is not a hard error
  });

  it("clamps the score to the [0,1] range", () => {
    const s = schema({
      labels: [
        {
          schemaName: "s",
          name: "L",
          displayName: "L",
          description: null,
          naturalKeyProps: [],
          properties: [prop({ key: "a", required: true })],
        },
      ],
    });
    const result = validateNodeAgainstSchema({ label: "L", properties: {} }, s);
    expect(result.conformanceScore).toBe(0);
  });
});

describe("enforcement-mode outcome classification", () => {
  function labelSchema(
    mode: PinnedSchema["enforcementMode"],
    floor = 0.5,
  ): PinnedSchema {
    return schema({
      enforcementMode: mode,
      conformanceFloor: floor,
      labels: [
        {
          schemaName: "s",
          name: "L",
          displayName: "L",
          description: null,
          naturalKeyProps: [],
          properties: [
            prop({ key: "a", required: true }),
            prop({ key: "b", required: true }),
          ],
        },
      ],
    });
  }

  it("strict: a hard error → outcome=rejected", () => {
    const result = validateNodeAgainstSchema(
      { label: "L", properties: { a: "x" } },
      labelSchema("strict"),
    );
    expect(result.outcome).toBe("rejected");
  });

  it("lenient: a hard error → outcome=written_below_floor", () => {
    const result = validateNodeAgainstSchema(
      { label: "L", properties: { a: "x" } },
      labelSchema("lenient"),
    );
    expect(result.outcome).toBe("written_below_floor");
  });

  it("off: a clean node → outcome=accepted (score 1 ≥ floor)", () => {
    const result = validateNodeAgainstSchema(
      { label: "L", properties: { a: "x", b: "y" } },
      labelSchema("off"),
    );
    expect(result.outcome).toBe("accepted");
  });

  it("valid but below floor → written_below_floor", () => {
    // One optional miss over 4 props keeps it valid but below a high floor.
    const s = schema({
      enforcementMode: "lenient",
      conformanceFloor: 0.95,
      labels: [
        {
          schemaName: "s",
          name: "L",
          displayName: "L",
          description: null,
          naturalKeyProps: [],
          properties: [
            prop({ key: "a", required: true }),
            prop({ key: "b", required: false }),
          ],
        },
      ],
    });
    const result = validateNodeAgainstSchema(
      { label: "L", properties: { a: "x" } },
      s,
    );
    expect(result.valid).toBe(true);
    expect(result.conformanceScore).toBeLessThan(0.95);
    expect(result.outcome).toBe("written_below_floor");
  });
});

describe("validateRelationshipAgainstSchema", () => {
  const s = schema({
    relationshipTypes: [
      {
        schemaName: "crm",
        name: "SIGNED_CONTRACT",
        displayName: "Signed Contract",
        description: null,
        startLabel: "Customer",
        endLabel: "Contract",
        cardinality: "one_to_many",
        properties: [
          prop({ key: "signedAt", dataType: "datetime", required: true }),
        ],
      },
    ],
  });

  it("unknown relationship type → pass-through", () => {
    const result = validateRelationshipAgainstSchema(
      { type: "UNKNOWN", startLabel: "A", endLabel: "B", properties: {} },
      s,
    );
    expect(result.valid).toBe(true);
    expect(result.conformanceScore).toBe(1);
  });

  it("missing required property on a known relationship", () => {
    const result = validateRelationshipAgainstSchema(
      {
        type: "SIGNED_CONTRACT",
        startLabel: "Customer",
        endLabel: "Contract",
        properties: {},
      },
      s,
    );
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toEqual(["signedAt"]);
  });

  it("rejects a wrong start endpoint with a type error", () => {
    const result = validateRelationshipAgainstSchema(
      {
        type: "SIGNED_CONTRACT",
        startLabel: "Vendor",
        endLabel: "Contract",
        properties: { signedAt: "2026-01-01T00:00:00Z" },
      },
      s,
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.field === "startLabel" && e.code === "type"),
    ).toBe(true);
  });

  it("accepts a fully-conformant relationship", () => {
    const result = validateRelationshipAgainstSchema(
      {
        type: "SIGNED_CONTRACT",
        startLabel: "Customer",
        endLabel: "Contract",
        properties: { signedAt: "2026-01-01T00:00:00Z" },
      },
      s,
    );
    expect(result.valid).toBe(true);
    expect(result.conformanceScore).toBe(1);
  });
});
