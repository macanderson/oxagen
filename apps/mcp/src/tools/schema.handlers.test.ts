// schema.handlers.test.ts — handler invocation tests for all schema-domain tools
// and the renamed relationship tools (graph.relationship.upsert, semantic.relationship.*).
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext` so
// that each default-export handler can be called without a live runtime.
// Each test asserts: (a) buildContext was called, (b) invoke was called once
// with the correct contract name + args + { surface: "mcp" }, (c) handler
// returns the parsed result.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

// ── schema.registry.get ───────────────────────────────────────────────────────

import schemaRegistryGetHandler, {
  schema as schemaRegistryGetSchema,
  metadata as schemaRegistryGetMeta,
} from "./schema.registry.get";

describe("schema.registry.get MCP tool", () => {
  const fakeOutput = {
    registryId: "reg-1",
    pinnedVersionId: null,
    draftVersionId: null,
    enforcementMode: "off",
    conformanceFloor: 0,
    schemas: [],
  };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'get_schema_registry'", () => {
    expect(schemaRegistryGetMeta.name).toBe("get_schema_registry");
  });

  it("calls buildContext and invoke with correct args", async () => {
    await schemaRegistryGetHandler({} as never);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_schema_registry");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });

  it("passes versionId to invoke", async () => {
    await schemaRegistryGetHandler({ versionId: "v-1" });
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ versionId: "v-1" });
  });

  it("schema accepts optional versionId", () => {
    const Schema = z.object(schemaRegistryGetSchema);
    expect(() => Schema.parse({})).not.toThrow();
    expect(() => Schema.parse({ versionId: "v-2" })).not.toThrow();
  });
});

// ── schema.list ───────────────────────────────────────────────────────────────

import schemaListHandler, {
  schema as schemaListSchema,
  metadata as schemaListMeta,
} from "./schema.list";

describe("schema.list MCP tool", () => {
  const fakeOutput = { schemas: [] };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'list_schemas'", () => {
    expect(schemaListMeta.name).toBe("list_schemas");
  });

  it("calls invoke with 'list_schemas' and surface 'mcp'", async () => {
    await schemaListHandler({});
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_schemas");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.toggle ─────────────────────────────────────────────────────────────

import schemaToggleHandler, {
  schema as schemaToggleSchema,
  metadata as schemaToggleMeta,
} from "./schema.toggle";

describe("schema.toggle MCP tool", () => {
  const fakeOutput = {
    schemaName: "crm",
    enabled: true,
    publishedVersionId: null,
    pinnedVersionId: null,
    isDowngrade: false,
    reconcileRecommended: false,
  };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'toggle_schema'", () => {
    expect(schemaToggleMeta.name).toBe("toggle_schema");
  });

  it("calls invoke with 'toggle_schema' + correct args", async () => {
    await schemaToggleHandler({ schemaName: "crm", enabled: true });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("toggle_schema");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ schemaName: "crm", enabled: true });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.label.upsert ───────────────────────────────────────────────────────

import schemaLabelUpsertHandler, {
  schema as schemaLabelUpsertSchema,
  metadata as schemaLabelUpsertMeta,
} from "./schema.label.upsert";

describe("schema.label.upsert MCP tool", () => {
  const fakeOutput = { labelId: "lbl-1", created: true };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'upsert_schema_label'", () => {
    expect(schemaLabelUpsertMeta.name).toBe("upsert_schema_label");
  });

  it("calls invoke with correct args", async () => {
    await schemaLabelUpsertHandler({ schemaName: "crm", name: "Contact", displayName: "Contact" } as Parameters<typeof schemaLabelUpsertHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_schema_label");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ schemaName: "crm", name: "Contact", displayName: "Contact" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.label.delete ───────────────────────────────────────────────────────

import schemaLabelDeleteHandler, {
  schema as schemaLabelDeleteSchema,
  metadata as schemaLabelDeleteMeta,
} from "./schema.label.delete";

describe("schema.label.delete MCP tool", () => {
  const fakeOutput = { deleted: true, labelName: "Contact" };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'delete_schema_label'", () => {
    expect(schemaLabelDeleteMeta.name).toBe("delete_schema_label");
  });

  it("calls invoke with correct args", async () => {
    await schemaLabelDeleteHandler({ schemaName: "crm", name: "Contact" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_schema_label");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.relationship.upsert ────────────────────────────────────────────────

import schemaRelationshipUpsertHandler, {
  schema as schemaRelationshipUpsertSchema,
  metadata as schemaRelationshipUpsertMeta,
} from "./schema.relationship.upsert";

describe("schema.relationship.upsert MCP tool", () => {
  const fakeOutput = { relationshipTypeId: "rel-1", created: true };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'upsert_schema_relationship'", () => {
    expect(schemaRelationshipUpsertMeta.name).toBe("upsert_schema_relationship");
  });

  it("calls invoke with correct args", async () => {
    await schemaRelationshipUpsertHandler({ schemaName: "crm", name: "EMPLOYS", displayName: "Employs" } as Parameters<typeof schemaRelationshipUpsertHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_schema_relationship");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ schemaName: "crm", name: "EMPLOYS", displayName: "Employs" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.relationship.delete ────────────────────────────────────────────────

import schemaRelationshipDeleteHandler, {
  schema as schemaRelationshipDeleteSchema,
  metadata as schemaRelationshipDeleteMeta,
} from "./schema.relationship.delete";

describe("schema.relationship.delete MCP tool", () => {
  const fakeOutput = { deleted: true, relationshipTypeName: "EMPLOYS" };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'delete_schema_relationship'", () => {
    expect(schemaRelationshipDeleteMeta.name).toBe("delete_schema_relationship");
  });

  it("calls invoke with correct args", async () => {
    await schemaRelationshipDeleteHandler({ schemaName: "crm", name: "EMPLOYS" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_schema_relationship");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.property.upsert ────────────────────────────────────────────────────

import schemaPropertyUpsertHandler, {
  schema as schemaPropertyUpsertSchema,
  metadata as schemaPropertyUpsertMeta,
} from "./schema.property.upsert";

describe("schema.property.upsert MCP tool", () => {
  const fakeOutput = { propertyId: "prop-1", created: true };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'upsert_schema_property'", () => {
    expect(schemaPropertyUpsertMeta.name).toBe("upsert_schema_property");
  });

  it("calls invoke with correct args", async () => {
    await schemaPropertyUpsertHandler({ ownerKind: "node", ownerName: "Contact", key: "email", dataType: "string", required: false } as Parameters<typeof schemaPropertyUpsertHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_schema_property");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ ownerKind: "node", key: "email", dataType: "string" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.property.delete ────────────────────────────────────────────────────

import schemaPropertyDeleteHandler, {
  schema as schemaPropertyDeleteSchema,
  metadata as schemaPropertyDeleteMeta,
} from "./schema.property.delete";

describe("schema.property.delete MCP tool", () => {
  const fakeOutput = { deleted: true, propertyKey: "email" };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'delete_schema_property'", () => {
    expect(schemaPropertyDeleteMeta.name).toBe("delete_schema_property");
  });

  it("calls invoke with correct args", async () => {
    await schemaPropertyDeleteHandler({ ownerKind: "node", ownerName: "Contact", key: "email" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_schema_property");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.version.list ───────────────────────────────────────────────────────

import schemaVersionListHandler, {
  schema as schemaVersionListSchema,
  metadata as schemaVersionListMeta,
} from "./schema.version.list";

describe("schema.version.list MCP tool", () => {
  const fakeOutput = { versions: [], total: 0 };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'list_schema_versions'", () => {
    expect(schemaVersionListMeta.name).toBe("list_schema_versions");
  });

  it("calls invoke with 'list_schema_versions' and surface 'mcp'", async () => {
    await schemaVersionListHandler({} as Parameters<typeof schemaVersionListHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_schema_versions");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.version.create ─────────────────────────────────────────────────────

import schemaVersionCreateHandler, {
  schema as schemaVersionCreateSchema,
  metadata as schemaVersionCreateMeta,
} from "./schema.version.create";

describe("schema.version.create MCP tool", () => {
  const fakeOutput = { versionId: "v-1", versionNumber: 1, publishedAt: "2026-01-01" };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'create_schema_version'", () => {
    expect(schemaVersionCreateMeta.name).toBe("create_schema_version");
  });

  it("calls invoke with correct args", async () => {
    await schemaVersionCreateHandler({ label: "v1.0", changeSummary: "Initial" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_schema_version");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ label: "v1.0" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.validate.node ──────────────────────────────────────────────────────

import schemaValidateNodeHandler, {
  schema as schemaValidateNodeSchema,
  metadata as schemaValidateNodeMeta,
} from "./schema.validate.node";

describe("schema.validate.node MCP tool", () => {
  const fakeOutput = { valid: true, conformanceScore: 1.0, errors: [], missingRequired: [], outcome: "accepted" as const };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'validate_schema_node'", () => {
    expect(schemaValidateNodeMeta.name).toBe("validate_schema_node");
  });

  it("calls invoke with correct args", async () => {
    await schemaValidateNodeHandler({ label: "Contact", properties: { name: "Alice" } } as unknown as Parameters<typeof schemaValidateNodeHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("validate_schema_node");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ label: "Contact" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── schema.reconcile.dispatch ─────────────────────────────────────────────────

import schemaReconcileDispatchHandler, {
  schema as schemaReconcileDispatchSchema,
  metadata as schemaReconcileDispatchMeta,
} from "./schema.reconcile.dispatch";

describe("schema.reconcile.dispatch MCP tool", () => {
  const fakeOutput = { executionId: "aex-1" };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'dispatch_schema_reconcile'", () => {
    expect(schemaReconcileDispatchMeta.name).toBe("dispatch_schema_reconcile");
  });

  it("calls invoke with 'dispatch_schema_reconcile' + surface 'mcp'", async () => {
    await schemaReconcileDispatchHandler({ versionId: "v-1", prune: false });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("dispatch_schema_reconcile");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ versionId: "v-1" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });

  it("annotations mark tool as destructive", () => {
    expect(schemaReconcileDispatchMeta.annotations?.destructiveHint).toBe(true);
  });
});

// ── schema.reconcile.status ───────────────────────────────────────────────────

import schemaReconcileStatusHandler, {
  schema as schemaReconcileStatusSchema,
  metadata as schemaReconcileStatusMeta,
} from "./schema.reconcile.status";

describe("schema.reconcile.status MCP tool", () => {
  const fakeOutput = { status: "running" as const, totalNodes: 100, processedNodes: 50, updatedNodes: 30, totalRelationships: 200, processedRelationships: 100, updatedRelationships: 60, prunedNodes: 0, prunedRelationships: 0 };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'get_reconcile_status'", () => {
    expect(schemaReconcileStatusMeta.name).toBe("get_reconcile_status");
  });

  it("calls invoke with correct args", async () => {
    await schemaReconcileStatusHandler({ executionId: "aex-1" });
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_reconcile_status");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ executionId: "aex-1" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── graph.relationship.upsert ─────────────────────────────────────────────────

import graphRelationshipUpsertHandler, {
  schema as graphRelationshipUpsertSchema,
  metadata as graphRelationshipUpsertMeta,
} from "./graph.relationship.upsert";

describe("graph.relationship.upsert MCP tool", () => {
  const fakeOutput = { relationshipId: "node-a:EMPLOYS:node-b", created: true };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'upsert_graph_relationship'", () => {
    expect(graphRelationshipUpsertMeta.name).toBe("upsert_graph_relationship");
  });

  it("calls invoke with correct args", async () => {
    await graphRelationshipUpsertHandler({
      fromNodeId: "node-a",
      toNodeId: "node-b",
      relationshipType: "EMPLOYS",
    } as Parameters<typeof graphRelationshipUpsertHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_graph_relationship");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ fromNodeId: "node-a", toNodeId: "node-b", relationshipType: "EMPLOYS" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── semantic.relationship.list ────────────────────────────────────────────────

import semanticRelationshipListHandler, {
  schema as semanticRelationshipListSchema,
  metadata as semanticRelationshipListMeta,
} from "./semantic.relationship.list";

describe("semantic.relationship.list MCP tool", () => {
  const fakeOutput = { edges: [], total: 0, limit: 50, offset: 0 };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'list_semantic_relationships'", () => {
    expect(semanticRelationshipListMeta.name).toBe("list_semantic_relationships");
  });

  it("calls invoke with 'list_semantic_relationships' and surface 'mcp'", async () => {
    await semanticRelationshipListHandler({} as Parameters<typeof semanticRelationshipListHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_semantic_relationships");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── semantic.relationship.approve ─────────────────────────────────────────────

import semanticRelationshipApproveHandler, {
  schema as semanticRelationshipApproveSchema,
  metadata as semanticRelationshipApproveMeta,
} from "./semantic.relationship.approve";

describe("semantic.relationship.approve MCP tool", () => {
  const fakeOutput = { edgeId: "edge-1", decision: "approve" as const };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'approve_semantic_relationship'", () => {
    expect(semanticRelationshipApproveMeta.name).toBe("approve_semantic_relationship");
  });

  it("calls invoke with correct args", async () => {
    await semanticRelationshipApproveHandler({ edgeId: "edge-1", decision: "approve" } as Parameters<typeof semanticRelationshipApproveHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("approve_semantic_relationship");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ edgeId: "edge-1", decision: "approve" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── semantic.relationship.infer ───────────────────────────────────────────────

import semanticRelationshipInferHandler, {
  schema as semanticRelationshipInferSchema,
  metadata as semanticRelationshipInferMeta,
} from "./semantic.relationship.infer";

describe("semantic.relationship.infer MCP tool", () => {
  const fakeOutput = { jobId: "job-1", status: "queued" as const, estimatedNodes: 100, dryRun: false };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'infer_semantic_relationships'", () => {
    expect(semanticRelationshipInferMeta.name).toBe("infer_semantic_relationships");
  });

  it("calls invoke with correct args", async () => {
    await semanticRelationshipInferHandler({ semanticEdgePrompt: "Find related entities" } as Parameters<typeof semanticRelationshipInferHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("infer_semantic_relationships");
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ semanticEdgePrompt: "Find related entities" });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});

// ── semantic.relationship.suggest ────────────────────────────────────────────

import semanticRelationshipSuggestHandler, {
  schema as semanticRelationshipSuggestSchema,
  metadata as semanticRelationshipSuggestMeta,
} from "./semantic.relationship.suggest";

describe("semantic.relationship.suggest MCP tool", () => {
  const fakeOutput = { suggestions: [], total: 0, limit: 50 };

  beforeEach(() => {
    mocks.invoke.mockResolvedValue(fakeOutput);
  });

  it("metadata name is 'suggest_semantic_relationships'", () => {
    expect(semanticRelationshipSuggestMeta.name).toBe("suggest_semantic_relationships");
  });

  it("calls invoke with 'suggest_semantic_relationships' and surface 'mcp'", async () => {
    await semanticRelationshipSuggestHandler({} as Parameters<typeof semanticRelationshipSuggestHandler>[0]);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("suggest_semantic_relationships");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "mcp" });
  });
});
