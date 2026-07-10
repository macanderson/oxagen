import { describe, it, expect } from "vitest";
import { getCapability } from "../registry";
import { RELATIONSHIP_TYPE_PATTERN } from "../lib/relationship-type-pattern";
import { FieldErrorSchema, PropertyInputSchema } from "./schema.shared";
import { schemaRegistryGet } from "./schema.registry.get";
import { schemaRegistryConfig } from "./schema.registry.config";
import { schemaList } from "./schema.list";
import { schemaToggle } from "./schema.toggle";
import { schemaLabelUpsert } from "./schema.label.upsert";
import { schemaLabelDelete } from "./schema.label.delete";
import { schemaRelationshipUpsert } from "./schema.relationship.upsert";
import { schemaRelationshipDelete } from "./schema.relationship.delete";
import { schemaPropertyUpsert } from "./schema.property.upsert";
import { schemaPropertyDelete } from "./schema.property.delete";
import { schemaVersionCreate } from "./schema.version.create";
import { schemaVersionPin } from "./schema.version.pin";
import { schemaVersionList } from "./schema.version.list";
import { schemaVersionDiff } from "./schema.version.diff";
import { schemaExport } from "./schema.export";
import { schemaRecommend } from "./schema.recommend";
import { schemaSetup } from "./schema.setup";
import { schemaChat } from "./schema.chat";
import { schemaValidateNode } from "./schema.validate.node";
import { schemaValidateRelationship } from "./schema.validate.relationship";
import { schemaReconcileDispatch } from "./schema.reconcile.dispatch";
import { schemaReconcileStatus } from "./schema.reconcile.status";

// Ensure the imports above are not tree-shaken by referencing them
void [
  schemaRegistryGet,
  schemaRegistryConfig,
  schemaList,
  schemaToggle,
  schemaLabelUpsert,
  schemaLabelDelete,
  schemaRelationshipUpsert,
  schemaRelationshipDelete,
  schemaPropertyUpsert,
  schemaPropertyDelete,
  schemaVersionCreate,
  schemaVersionPin,
  schemaVersionList,
  schemaVersionDiff,
  schemaExport,
  schemaRecommend,
  schemaSetup,
  schemaChat,
  schemaValidateNode,
  schemaValidateRelationship,
  schemaReconcileDispatch,
  schemaReconcileStatus,
];

describe("RELATIONSHIP_TYPE_PATTERN", () => {
  it("accepts valid uppercase types", () => {
    expect(RELATIONSHIP_TYPE_PATTERN.test("EMPLOYS")).toBe(true);
    expect(RELATIONSHIP_TYPE_PATTERN.test("SIGNED_CONTRACT")).toBe(true);
    expect(RELATIONSHIP_TYPE_PATTERN.test("A")).toBe(true);
  });
  it("rejects injection strings", () => {
    expect(RELATIONSHIP_TYPE_PATTERN.test("`]->()-[:x`")).toBe(false);
    expect(RELATIONSHIP_TYPE_PATTERN.test("lowercase")).toBe(false);
    expect(RELATIONSHIP_TYPE_PATTERN.test("HAS SPACE")).toBe(false);
    expect(RELATIONSHIP_TYPE_PATTERN.test("")).toBe(false);
  });
});

describe("FieldErrorSchema", () => {
  it("parses valid field error", () => {
    const result = FieldErrorSchema.safeParse({
      field: "name",
      message: "required",
      code: "required",
    });
    expect(result.success).toBe(true);
  });
  it("rejects unknown code", () => {
    const result = FieldErrorSchema.safeParse({
      field: "name",
      message: "bad",
      code: "notacode",
    });
    expect(result.success).toBe(false);
  });
});

describe("PropertyInputSchema", () => {
  it("parses valid property", () => {
    const result = PropertyInputSchema.safeParse({
      key: "email",
      dataType: "email",
      required: true,
    });
    expect(result.success).toBe(true);
  });
  it("rejects unknown dataType", () => {
    const result = PropertyInputSchema.safeParse({
      key: "x",
      dataType: "uuid",
      required: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("schema.toggle contract", () => {
  it("registers and output shape is valid", () => {
    const cap = getCapability("toggle_schema");
    expect(cap).toBeDefined();
    const result = cap!.output.safeParse({
      schemaName: "sales_crm",
      enabled: true,
      publishedVersionId: "scv_123",
      pinnedVersionId: "scv_123",
      isDowngrade: false,
      reconcileRecommended: true,
    });
    expect(result.success).toBe(true);
  });
  it("rejects toggle output missing pinnedVersionId", () => {
    const cap = getCapability("toggle_schema");
    const result = cap!.output.safeParse({
      schemaName: "x",
      enabled: true,
      publishedVersionId: null,
      isDowngrade: false,
      reconcileRecommended: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("schema.label.upsert contract", () => {
  it("registers and IO shape valid", () => {
    const cap = getCapability("upsert_schema_label");
    expect(cap).toBeDefined();
    const inputResult = cap!.input.safeParse({
      schemaName: "starter",
      name: "Customer",
      displayName: "Customer",
      description: "A paying customer",
      naturalKeyProps: ["email"],
    });
    expect(inputResult.success).toBe(true);
    const outputResult = cap!.output.safeParse({
      labelId: "scl_abc",
      created: true,
    });
    expect(outputResult.success).toBe(true);
  });
  it("rejects label upsert missing required fields", () => {
    const cap = getCapability("upsert_schema_label");
    const result = cap!.input.safeParse({ name: "Customer" });
    expect(result.success).toBe(false);
  });
});

describe("schema.validate.node contract", () => {
  it("registers and IO shape valid", () => {
    const cap = getCapability("validate_schema_node");
    expect(cap).toBeDefined();
    const inputResult = cap!.input.safeParse({
      label: "Customer",
      properties: { email: "test@example.com" },
    });
    expect(inputResult.success).toBe(true);
    const outputResult = cap!.output.safeParse({
      valid: true,
      conformanceScore: 0.95,
      errors: [],
      missingRequired: [],
      outcome: "accepted",
    });
    expect(outputResult.success).toBe(true);
  });
  it("rejects invalid outcome value", () => {
    const cap = getCapability("validate_schema_node");
    const result = cap!.output.safeParse({
      valid: false,
      conformanceScore: 0.3,
      errors: [],
      missingRequired: ["name"],
      outcome: "unknown_outcome",
    });
    expect(result.success).toBe(false);
  });
});

describe("schema.recommend contract", () => {
  it("registers and IO shape valid", () => {
    const cap = getCapability("recommend_schema");
    expect(cap).toBeDefined();
    const inputResult = cap!.input.safeParse({ sampleLimit: 200 });
    expect(inputResult.success).toBe(true);
    const outputResult = cap!.output.safeParse({
      proposal: {
        schemas: [
          {
            name: "starter",
            displayName: "Starter",
            labels: [
              {
                name: "Customer",
                properties: [
                  { key: "email", dataType: "email", required: true },
                ],
              },
            ],
            relationshipTypes: [
              { name: "EMPLOYS", startLabel: "Company", endLabel: "Person" },
            ],
          },
        ],
      },
      rationale: "Based on observed labels...",
      sampledCount: 187,
    });
    expect(outputResult.success).toBe(true);
  });
});

describe("all 22 schema contracts register", () => {
  const expectedNames = [
    "get_schema_registry",
    "get_registry_config",
    "list_schemas",
    "toggle_schema",
    "upsert_schema_label",
    "delete_schema_label",
    "upsert_schema_relationship",
    "delete_schema_relationship",
    "upsert_schema_property",
    "delete_schema_property",
    "create_schema_version",
    "pin_schema_version",
    "list_schema_versions",
    "diff_schema_versions",
    "export_schema",
    "recommend_schema",
    "setup_schema",
    "run_schema_chat",
    "validate_schema_node",
    "validate_schema_relationship",
    "dispatch_schema_reconcile",
    "get_reconcile_status",
  ];
  for (const name of expectedNames) {
    it(`${name} registers`, () => {
      expect(getCapability(name)).toBeDefined();
    });
  }
});
