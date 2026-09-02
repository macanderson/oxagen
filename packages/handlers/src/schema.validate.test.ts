import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  PinnedSchema,
  SchemaFieldError,
} from "@oxagen/ingestion/validate";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getPinnedSchema: vi.fn(),
}));

vi.mock("./schema.pinned", () => ({
  getPinnedSchema: mocks.getPinnedSchema,
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaValidateNodeHandler } from "./schema.validate.node";
import { schemaValidateRelationshipHandler } from "./schema.validate.relationship";
import { toContractFieldErrors } from "./schema.validate.shared";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const prop = (
  over: Partial<PinnedSchema["labels"][number]["properties"][number]> & {
    key: string;
  },
) => ({
  key: over.key,
  dataType: over.dataType ?? "string",
  required: over.required ?? false,
  description: over.description ?? null,
  enumValues: over.enumValues ?? null,
  itemType: over.itemType ?? null,
  constraints: over.constraints ?? {},
  example: over.example ?? null,
});

const PINNED: PinnedSchema = {
  registryId: "scr_1",
  versionId: "scv_1",
  versionNumber: 1,
  enforcementMode: "lenient",
  conformanceFloor: 0.5,
  labels: [
    {
      schemaName: "customer",
      name: "Customer",
      displayName: "Customer",
      description: null,
      naturalKeyProps: ["customer_id"],
      properties: [
        prop({ key: "customer_id", required: true }),
        prop({ key: "name", required: true }),
        prop({
          key: "status",
          dataType: "enum",
          enumValues: ["active", "churned"],
        }),
      ],
    },
  ],
  relationshipTypes: [
    {
      schemaName: "customer",
      name: "BELONGS_TO",
      displayName: "Belongs To",
      description: null,
      startLabel: "Customer",
      endLabel: "Organization",
      cardinality: "many_to_many",
      properties: [],
    },
  ],
};

beforeEach(() => {
  mocks.getPinnedSchema.mockReset();
  mocks.getPinnedSchema.mockResolvedValue(PINNED);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("toContractFieldErrors", () => {
  it("collapses minLength/maxLength onto min/max and passes other codes through", () => {
    const input: SchemaFieldError[] = [
      { field: "a", message: "too short", code: "minLength" },
      { field: "b", message: "too long", code: "maxLength" },
      { field: "c", message: "required", code: "required" },
      { field: "d", message: "bad type", code: "type" },
      { field: "e", message: "not allowed", code: "oneOf" },
    ];
    expect(toContractFieldErrors(input)).toEqual([
      { field: "a", message: "too short", code: "min" },
      { field: "b", message: "too long", code: "max" },
      { field: "c", message: "required", code: "required" },
      { field: "d", message: "bad type", code: "type" },
      { field: "e", message: "not allowed", code: "oneOf" },
    ]);
  });
});

describe("schemaValidateNodeHandler", () => {
  it("returns valid + score 1 + accepted for a fully conformant node", async () => {
    const res = await schemaValidateNodeHandler(
      {
        label: "Customer",
        properties: { customer_id: "C-1", name: "Acme Corp", status: "active" },
      },
      CTX,
    );
    expect(res.valid).toBe(true);
    expect(res.conformanceScore).toBe(1);
    expect(res.errors).toEqual([]);
    expect(res.missingRequired).toEqual([]);
    expect(res.outcome).toBe("accepted");
  });

  it("flags missing required properties with required-coded errors", async () => {
    const res = await schemaValidateNodeHandler(
      { label: "Customer", properties: { status: "active" } },
      CTX,
    );
    expect(res.valid).toBe(false);
    expect(res.missingRequired).toEqual(
      expect.arrayContaining(["customer_id", "name"]),
    );
    expect(res.errors.every((e) => e.code === "required")).toBe(true);
    // Lenient enforcement + invalid → classified as written_below_floor (never rejected).
    expect(res.outcome).toBe("written_below_floor");
  });

  it("rejects an invalid node under strict enforcement", async () => {
    mocks.getPinnedSchema.mockResolvedValue({
      ...PINNED,
      enforcementMode: "strict",
    });
    const res = await schemaValidateNodeHandler(
      { label: "Customer", properties: {} },
      CTX,
    );
    expect(res.valid).toBe(false);
    expect(res.outcome).toBe("rejected");
  });

  it("flags an out-of-range enum value with a oneOf error", async () => {
    const res = await schemaValidateNodeHandler(
      {
        label: "Customer",
        properties: { customer_id: "C-1", name: "Acme", status: "frozen" },
      },
      CTX,
    );
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.field === "status" && e.code === "oneOf"),
    ).toBe(true);
  });

  it("passes through an unknown label as fully conformant", async () => {
    const res = await schemaValidateNodeHandler(
      { label: "NotInSchema", properties: { whatever: 1 } },
      CTX,
    );
    expect(res.valid).toBe(true);
    expect(res.conformanceScore).toBe(1);
    expect(res.outcome).toBe("accepted");
  });

  it("passes through when no version is pinned (registry inert)", async () => {
    mocks.getPinnedSchema.mockResolvedValue(null);
    const res = await schemaValidateNodeHandler(
      { label: "Customer", properties: {} },
      CTX,
    );
    expect(res).toEqual({
      valid: true,
      conformanceScore: 1,
      errors: [],
      missingRequired: [],
      outcome: "accepted",
    });
  });
});

describe("schemaValidateRelationshipHandler", () => {
  it("validates a conformant relationship with matching endpoints", async () => {
    const res = await schemaValidateRelationshipHandler(
      {
        type: "BELONGS_TO",
        startLabel: "Customer",
        endLabel: "Organization",
        properties: {},
      },
      CTX,
    );
    expect(res.valid).toBe(true);
    expect(res.outcome).toBe("accepted");
  });

  it("flags an endpoint-constraint violation as a type error", async () => {
    const res = await schemaValidateRelationshipHandler(
      {
        type: "BELONGS_TO",
        startLabel: "Customer",
        endLabel: "WrongLabel",
        properties: {},
      },
      CTX,
    );
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.field === "endLabel" && e.code === "type"),
    ).toBe(true);
  });

  it("passes through when no version is pinned", async () => {
    mocks.getPinnedSchema.mockResolvedValue(null);
    const res = await schemaValidateRelationshipHandler(
      {
        type: "BELONGS_TO",
        startLabel: "Customer",
        endLabel: "Organization",
        properties: {},
      },
      CTX,
    );
    expect(res.valid).toBe(true);
    expect(res.outcome).toBe("accepted");
  });
});
