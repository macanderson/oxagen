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
import { graphRelationshipUpsert } from "./graph.relationship.upsert";
import { semanticRelationshipApprove } from "./semantic.relationship.approve";
import { semanticRelationshipInfer } from "./semantic.relationship.infer";
import { semanticRelationshipList } from "./semantic.relationship.list";
import { semanticRelationshipSuggest } from "./semantic.relationship.suggest";

// Ensure the imports above are not tree-shaken by referencing them
void [
  schemaRegistryGet, schemaRegistryConfig, schemaList, schemaToggle,
  schemaLabelUpsert, schemaLabelDelete, schemaRelationshipUpsert, schemaRelationshipDelete,
  schemaPropertyUpsert, schemaPropertyDelete, schemaVersionCreate, schemaVersionPin,
  schemaVersionList, schemaVersionDiff, schemaExport, schemaRecommend,
  schemaSetup, schemaChat, schemaValidateNode, schemaValidateRelationship,
  schemaReconcileDispatch, schemaReconcileStatus, graphRelationshipUpsert,
  semanticRelationshipApprove, semanticRelationshipInfer, semanticRelationshipList,
  semanticRelationshipSuggest,
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
    const result = FieldErrorSchema.safeParse({ field: "name", message: "required", code: "required" });
    expect(result.success).toBe(true);
  });
  it("rejects unknown code", () => {
    const result = FieldErrorSchema.safeParse({ field: "name", message: "bad", code: "notacode" });
    expect(result.success).toBe(false);
  });
});

describe("PropertyInputSchema", () => {
  it("parses valid property", () => {
    const result = PropertyInputSchema.safeParse({ key: "email", dataType: "email", required: true });
    expect(result.success).toBe(true);
  });
  it("rejects unknown dataType", () => {
    const result = PropertyInputSchema.safeParse({ key: "x", dataType: "uuid", required: false });
    expect(result.success).toBe(false);
  });
});

describe("schema.toggle contract", () => {
  it("registers and output shape is valid", () => {
    const cap = getCapability("schema.toggle");
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
    const cap = getCapability("schema.toggle");
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
    const cap = getCapability("schema.label.upsert");
    expect(cap).toBeDefined();
    const inputResult = cap!.input.safeParse({
      schemaName: "starter",
      name: "Customer",
      displayName: "Customer",
      description: "A paying customer",
      naturalKeyProps: ["email"],
    });
    expect(inputResult.success).toBe(true);
    const outputResult = cap!.output.safeParse({ labelId: "scl_abc", created: true });
    expect(outputResult.success).toBe(true);
  });
  it("rejects label upsert missing required fields", () => {
    const cap = getCapability("schema.label.upsert");
    const result = cap!.input.safeParse({ name: "Customer" });
    expect(result.success).toBe(false);
  });
});

describe("schema.validate.node contract", () => {
  it("registers and IO shape valid", () => {
    const cap = getCapability("schema.validate.node");
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
    const cap = getCapability("schema.validate.node");
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
    const cap = getCapability("schema.recommend");
    expect(cap).toBeDefined();
    const inputResult = cap!.input.safeParse({ sampleLimit: 200 });
    expect(inputResult.success).toBe(true);
    const outputResult = cap!.output.safeParse({
      proposal: {
        schemas: [{
          name: "starter",
          displayName: "Starter",
          labels: [{ name: "Customer", properties: [{ key: "email", dataType: "email", required: true }] }],
          relationshipTypes: [{ name: "EMPLOYS", startLabel: "Company", endLabel: "Person" }],
        }],
      },
      rationale: "Based on observed labels...",
      sampledCount: 187,
    });
    expect(outputResult.success).toBe(true);
  });
});

describe("graph.relationship.upsert contract", () => {
  it("registers under new name", () => {
    const cap = getCapability("graph.relationship.upsert");
    expect(cap).toBeDefined();
  });
  it("accepts valid relationship type", () => {
    const cap = getCapability("graph.relationship.upsert");
    const result = cap!.input.safeParse({
      fromNodeId: "kn_abc",
      toNodeId: "kn_def",
      relationshipType: "EMPLOYS",
    });
    expect(result.success).toBe(true);
  });
  it("rejects injection strings", () => {
    const cap = getCapability("graph.relationship.upsert");
    const result = cap!.input.safeParse({
      fromNodeId: "kn_abc",
      toNodeId: "kn_def",
      relationshipType: "`]->()-[:x`",
    });
    expect(result.success).toBe(false);
  });
});

describe("semantic.relationship.* contracts register", () => {
  it("semantic.relationship.approve registers", () => {
    expect(getCapability("semantic.relationship.approve")).toBeDefined();
  });
  it("semantic.relationship.infer registers", () => {
    expect(getCapability("semantic.relationship.infer")).toBeDefined();
  });
  it("semantic.relationship.list registers", () => {
    expect(getCapability("semantic.relationship.list")).toBeDefined();
  });
  it("semantic.relationship.suggest registers", () => {
    expect(getCapability("semantic.relationship.suggest")).toBeDefined();
  });
});

describe("all 22 schema contracts register", () => {
  const expectedNames = [
    "schema.registry.get", "schema.registry.config", "schema.list", "schema.toggle",
    "schema.label.upsert", "schema.label.delete", "schema.relationship.upsert",
    "schema.relationship.delete", "schema.property.upsert", "schema.property.delete",
    "schema.version.create", "schema.version.pin", "schema.version.list",
    "schema.version.diff", "schema.export", "schema.recommend", "schema.setup",
    "schema.chat", "schema.validate.node", "schema.validate.relationship",
    "schema.reconcile.dispatch", "schema.reconcile.status",
  ];
  for (const name of expectedNames) {
    it(`${name} registers`, () => {
      expect(getCapability(name)).toBeDefined();
    });
  }
});
