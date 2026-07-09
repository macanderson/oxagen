/**
 * Unit tests for schema route handlers (schema.ts) and related routes:
 *   semantic-relationship.ts, graph.relationship.upsert.ts
 *
 * Pattern: mock at the adapter seam (@oxagen/auth, @oxagen/oxagen/kernel,
 * @oxagen/billing, @oxagen/handlers, middleware/logger), assert happy path
 * forwards invoke result as JSON, invoke called once with correct contract
 * name + parsed input + surface "api".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke, clearHandlersForTests: vi.fn() };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileNotFoundError"; }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileForbiddenError"; }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

async function authGet(path: string): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, { headers: { authorization: bearerHeader("oxk_key") } }));
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: bearerHeader("oxk_key"), "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function authPut(path: string, body: unknown): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, {
    method: "PUT",
    headers: { authorization: bearerHeader("oxk_key"), "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function authDelete(path: string, body?: unknown): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, {
    method: "DELETE",
    headers: { authorization: bearerHeader("oxk_key"), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

// ── schema.registry.get ───────────────────────────────────────────────────────

describe("schema.registry.get route", () => {
  const PATH = "/schema/registry";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { registryId: "reg-1", schemas: [] };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_schema_registry' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_schema_registry");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?versionId=v1 → passes versionId to invoke", async () => {
    await authGet(`${PATH}?versionId=v1`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.versionId).toBe("v1");
  });

  it("no query params → versionId is undefined", async () => {
    await authGet(PATH);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.versionId).toBeUndefined();
  });
});

// ── schema.registry.config ───────────────────────────────────────────────────

describe("schema.registry.config route", () => {
  const PATH = "/schema/registry/config";

  it("happy path PUT: returns 200 with invoke result", async () => {
    const invokeResult = { registryId: "reg-1", enforcementMode: "off", conformanceFloor: 0 };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPut(PATH, { enforcementMode: "off" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_registry_config' and surface 'api'", async () => {
    await authPut(PATH, { enforcementMode: "lenient" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_registry_config");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes enforcementMode and conformanceFloor to invoke", async () => {
    await authPut(PATH, { enforcementMode: "strict", conformanceFloor: 0.8 });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.enforcementMode).toBe("strict");
    expect(body.conformanceFloor).toBe(0.8);
  });
});

// ── schema.list ───────────────────────────────────────────────────────────────

describe("schema.list route", () => {
  const PATH = "/schema";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { schemas: [{ schemaName: "crm", enabled: true }] };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_schemas' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_schemas");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });
});

// ── schema.toggle ─────────────────────────────────────────────────────────────

describe("schema.toggle route", () => {
  const PATH = "/schema/crm/toggle";

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { schemaName: "crm", enabled: true };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'toggle_schema' and surface 'api'", async () => {
    await authPost(PATH, { enabled: false });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("toggle_schema");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes schemaName from path param and enabled from body", async () => {
    await authPost(PATH, { enabled: true });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.schemaName).toBe("crm");
    expect(body.enabled).toBe(true);
  });

  it("missing enabled field → 400, invoke not called", async () => {
    const res = await authPost(PATH, {});
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.label.upsert ───────────────────────────────────────────────────────

describe("schema.label.upsert route", () => {
  const PATH = "/schema/crm/labels/Contact";

  it("happy path PUT: returns 200 with invoke result", async () => {
    const invokeResult = { labelId: "lbl-1", created: true };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPut(PATH, { displayName: "Contact" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'upsert_schema_label' and surface 'api'", async () => {
    await authPut(PATH, { displayName: "Contact" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_schema_label");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes schemaName and name from path params, displayName from body", async () => {
    await authPut(PATH, { displayName: "Contact Person" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.schemaName).toBe("crm");
    expect(body.name).toBe("Contact");
    expect(body.displayName).toBe("Contact Person");
  });

  it("missing displayName → 400, invoke not called", async () => {
    const res = await authPut(PATH, {});
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.label.delete ───────────────────────────────────────────────────────

describe("schema.label.delete route", () => {
  const PATH = "/schema/crm/labels/Contact";

  it("happy path DELETE: returns 200 with invoke result", async () => {
    const invokeResult = { deleted: true, labelName: "Contact" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authDelete(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'delete_schema_label' and surface 'api'", async () => {
    await authDelete(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_schema_label");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes schemaName and name from path params", async () => {
    await authDelete(PATH);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.schemaName).toBe("crm");
    expect(body.name).toBe("Contact");
  });
});

// ── schema.relationship.upsert ────────────────────────────────────────────────

describe("schema.relationship.upsert route", () => {
  const PATH = "/schema/crm/relationships/EMPLOYS";

  it("happy path PUT: returns 200 with invoke result", async () => {
    const invokeResult = { relationshipTypeId: "rel-1", created: true };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPut(PATH, { displayName: "Employs" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'upsert_schema_relationship' and surface 'api'", async () => {
    await authPut(PATH, { displayName: "Employs" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_schema_relationship");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes schemaName and name from path params", async () => {
    await authPut(PATH, { displayName: "Employs" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.schemaName).toBe("crm");
    expect(body.name).toBe("EMPLOYS");
    expect(body.displayName).toBe("Employs");
  });
});

// ── schema.relationship.delete ────────────────────────────────────────────────

describe("schema.relationship.delete route", () => {
  const PATH = "/schema/crm/relationships/EMPLOYS";

  it("happy path DELETE: returns 200 with invoke result", async () => {
    const invokeResult = { deleted: true, relationshipTypeName: "EMPLOYS" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authDelete(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'delete_schema_relationship' and surface 'api'", async () => {
    await authDelete(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_schema_relationship");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });
});

// ── schema.version.list ───────────────────────────────────────────────────────

describe("schema.version.list route", () => {
  const PATH = "/schema/versions";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { versions: [], total: 0 };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_schema_versions' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_schema_versions");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?limit=5&offset=10 → passes parsed numbers to invoke", async () => {
    await authGet(`${PATH}?limit=5&offset=10`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(10);
  });
});

// ── schema.version.create ─────────────────────────────────────────────────────

describe("schema.version.create route", () => {
  const PATH = "/schema/versions";

  it("happy path POST: returns 201 with invoke result", async () => {
    const invokeResult = { versionId: "v-1", versionNumber: 1, publishedAt: "2026-01-01" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, { label: "v1.0", changeSummary: "Initial release" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_schema_version' and surface 'api'", async () => {
    await authPost(PATH, {});
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_schema_version");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes label and changeSummary to invoke", async () => {
    await authPost(PATH, { label: "Sales CRM v2", changeSummary: "Added lead scoring" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.label).toBe("Sales CRM v2");
    expect(body.changeSummary).toBe("Added lead scoring");
  });
});

// ── schema.version.pin ────────────────────────────────────────────────────────

describe("schema.version.pin route", () => {
  const VERSION_ID = "ver-abc";
  const PATH = `/schema/versions/${VERSION_ID}/pin`;

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { pinnedVersionId: VERSION_ID, previousVersionId: null, isDowngrade: false, reconcileRecommended: false };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'pin_schema_version' and surface 'api'", async () => {
    await authPost(PATH, {});
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("pin_schema_version");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes versionId from path param to invoke", async () => {
    await authPost(PATH, {});
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.versionId).toBe(VERSION_ID);
  });
});

// ── schema.version.diff ───────────────────────────────────────────────────────

describe("schema.version.diff route", () => {
  const PATH = "/schema/versions/diff";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { schemasAdded: [], schemasRemoved: [], labelsAdded: [], labelsRemoved: [], labelsChanged: [], relationshipTypesAdded: [], relationshipTypesRemoved: [], relationshipTypesChanged: [], propertiesAdded: [], propertiesRemoved: [], propertiesChanged: [] };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(`${PATH}?fromVersionId=v1&toVersionId=v2`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'diff_schema_versions' and surface 'api'", async () => {
    await authGet(`${PATH}?fromVersionId=v1&toVersionId=v2`);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("diff_schema_versions");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes fromVersionId and toVersionId from query params", async () => {
    await authGet(`${PATH}?fromVersionId=v1&toVersionId=v2`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fromVersionId).toBe("v1");
    expect(body.toVersionId).toBe("v2");
  });

  it("missing fromVersionId → 400, invoke not called", async () => {
    const res = await authGet(`${PATH}?toVersionId=v2`);
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.export ─────────────────────────────────────────────────────────────

describe("schema.export route", () => {
  const PATH = "/schema/export";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { assetId: "a-1", serveUrl: "https://example.com/file.zip", versionId: "v-1", versionNumber: 1 };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'export_schema' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("export_schema");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?versionId=v1 → passes versionId to invoke", async () => {
    await authGet(`${PATH}?versionId=v1`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.versionId).toBe("v1");
  });
});

// ── schema.validate.node ──────────────────────────────────────────────────────

describe("schema.validate.node route", () => {
  const PATH = "/schema/validate/node";
  const VALID_BODY = { label: "Contact", properties: { name: "Alice" } };

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { valid: true, conformanceScore: 1.0, errors: [], missingRequired: [], outcome: "accepted" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'validate_schema_node' and surface 'api'", async () => {
    await authPost(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("validate_schema_node");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes label and properties to invoke", async () => {
    await authPost(PATH, VALID_BODY);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.label).toBe("Contact");
    expect(body.properties).toEqual({ name: "Alice" });
  });

  it("missing label → 400, invoke not called", async () => {
    const res = await authPost(PATH, { properties: {} });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.reconcile.dispatch ─────────────────────────────────────────────────

describe("schema.reconcile.dispatch route", () => {
  const PATH = "/schema/reconcile/dispatch";
  const VALID_BODY = { versionId: "v-1" };

  it("happy path POST: returns 202 with invoke result", async () => {
    const invokeResult = { executionId: "aex-123" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, VALID_BODY);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'dispatch_schema_reconcile' and surface 'api'", async () => {
    await authPost(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("dispatch_schema_reconcile");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes versionId and prune to invoke", async () => {
    await authPost(PATH, { versionId: "v-1", prune: true });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.versionId).toBe("v-1");
    expect(body.prune).toBe(true);
  });

  it("missing versionId → 400, invoke not called", async () => {
    const res = await authPost(PATH, {});
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.reconcile.status ───────────────────────────────────────────────────

describe("schema.reconcile.status route", () => {
  const PATH = "/schema/reconcile/status";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { status: "running", totalNodes: 100, processedNodes: 50, updatedNodes: 30, totalRelationships: 200, processedRelationships: 100, updatedRelationships: 60, prunedNodes: 0, prunedRelationships: 0 };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(`${PATH}?executionId=aex-123`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_reconcile_status' and surface 'api'", async () => {
    await authGet(`${PATH}?executionId=aex-123`);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_reconcile_status");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes executionId to invoke", async () => {
    await authGet(`${PATH}?executionId=aex-456`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.executionId).toBe("aex-456");
  });

  it("missing executionId → 400, invoke not called", async () => {
    const res = await authGet(PATH);
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.property.upsert ────────────────────────────────────────────────────

describe("schema.property.upsert route", () => {
  const PATH = "/schema/crm/properties/node/Contact/email";

  it("happy path PUT: returns 200 with invoke result", async () => {
    const invokeResult = { propertyId: "prop-1", created: true };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPut(PATH, { dataType: "string" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'upsert_schema_property' and surface 'api'", async () => {
    await authPut(PATH, { dataType: "string" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_schema_property");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes ownerKind, ownerName, key from path params and dataType from body", async () => {
    await authPut(PATH, { dataType: "email", required: true });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.ownerKind).toBe("node");
    expect(body.ownerName).toBe("Contact");
    expect(body.key).toBe("email");
    expect(body.dataType).toBe("email");
    expect(body.required).toBe(true);
  });

  it("missing dataType → 400, invoke not called", async () => {
    const res = await authPut(PATH, {});
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.property.delete ────────────────────────────────────────────────────

describe("schema.property.delete route", () => {
  const PATH = "/schema/crm/properties/node/Contact/email";

  it("happy path DELETE: returns 200 with invoke result", async () => {
    const invokeResult = { deleted: true, key: "email" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authDelete(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'delete_schema_property' and passes path params", async () => {
    await authDelete(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_schema_property");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.ownerKind).toBe("node");
    expect(body.ownerName).toBe("Contact");
    expect(body.key).toBe("email");
  });
});

// ── schema.recommend ──────────────────────────────────────────────────────────

describe("schema.recommend route", () => {
  const PATH = "/schema/recommend";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { labels: [], relationshipTypes: [] };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'recommend_schema' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("recommend_schema");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?sampleLimit=500 → passes parsed number to invoke", async () => {
    await authGet(`${PATH}?sampleLimit=500`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.sampleLimit).toBe(500);
  });
});

// ── schema.setup ──────────────────────────────────────────────────────────────

describe("schema.setup route", () => {
  const PATH = "/schema/setup";

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { applied: true, registryId: "reg-1" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, { enforcement: "lenient" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'setup_schema' and passes fields", async () => {
    await authPost(PATH, { enforcement: "strict", noInteractive: true });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("setup_schema");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.enforcement).toBe("strict");
    expect(body.noInteractive).toBe(true);
  });
});

// ── schema.validate.relationship ──────────────────────────────────────────────

describe("schema.validate.relationship route", () => {
  const PATH = "/schema/validate/relationship";
  const VALID_BODY = { type: "EMPLOYS", startLabel: "Company", endLabel: "Person", properties: { since: "2024" } };

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { valid: true, errors: [], outcome: "accepted" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'validate_schema_relationship' and passes fields", async () => {
    await authPost(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("validate_schema_relationship");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.type).toBe("EMPLOYS");
    expect(body.startLabel).toBe("Company");
    expect(body.endLabel).toBe("Person");
  });

  it("missing startLabel → 400, invoke not called", async () => {
    const res = await authPost(PATH, { type: "EMPLOYS", endLabel: "Person", properties: {} });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── schema.chat ───────────────────────────────────────────────────────────────

describe("schema.chat route", () => {
  const PATH = "/schema/chat";

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { assistantMessage: "Added a Contact label.", conversationId: "conv-1" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, { message: "Add a Contact label" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'run_schema_chat' and surface 'api'", async () => {
    await authPost(PATH, { message: "hello" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("run_schema_chat");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes message, conversationId and draftVersionId to invoke", async () => {
    await authPost(PATH, { message: "next turn", conversationId: "conv-9", draftVersionId: "ver-3" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.message).toBe("next turn");
    expect(body.conversationId).toBe("conv-9");
    expect(body.draftVersionId).toBe("ver-3");
  });

  it("missing message → 400, invoke not called", async () => {
    const res = await authPost(PATH, {});
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("empty message → 400, invoke not called", async () => {
    const res = await authPost(PATH, { message: "" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── graph.relationship.upsert ─────────────────────────────────────────────────

describe("graph.relationship.upsert route", () => {
  const PATH = "/graph/relationship/upsert";
  const VALID_BODY = {
    fromNodeId: "node-a",
    toNodeId: "node-b",
    relationshipType: "EMPLOYS",
  };

  it("happy path POST: returns 201 with invoke result", async () => {
    const invokeResult = { relationshipId: "node-a:EMPLOYS:node-b", created: true };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, VALID_BODY);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'upsert_graph_relationship' and surface 'api'", async () => {
    await authPost(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_graph_relationship");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes fromNodeId, toNodeId, relationshipType, properties to invoke", async () => {
    await authPost(PATH, { ...VALID_BODY, properties: { since: "2024" } });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fromNodeId).toBe("node-a");
    expect(body.toNodeId).toBe("node-b");
    expect(body.relationshipType).toBe("EMPLOYS");
    expect(body.properties).toEqual({ since: "2024" });
  });

  it("invalid relationshipType (lowercase) → 400, invoke not called", async () => {
    const res = await authPost(PATH, { ...VALID_BODY, relationshipType: "employs" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing fromNodeId → 400, invoke not called", async () => {
    const res = await authPost(PATH, { toNodeId: "node-b", relationshipType: "EMPLOYS" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── semantic.relationship.list ────────────────────────────────────────────────

describe("semantic.relationship.list route", () => {
  const PATH = "/semantic-relationships";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { edges: [], total: 0, limit: 50, offset: 0 };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_semantic_relationships' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_semantic_relationships");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?type=RELATED_TO&confidenceMin=0.5&limit=20&offset=5 → parsed to invoke", async () => {
    await authGet(`${PATH}?type=RELATED_TO&confidenceMin=0.5&limit=20&offset=5`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.type).toBe("RELATED_TO");
    expect(body.confidenceMin).toBe(0.5);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(5);
  });
});

// ── semantic.relationship.infer ───────────────────────────────────────────────

describe("semantic.relationship.infer route", () => {
  const PATH = "/semantic-relationships/infer";
  const VALID_BODY = { semanticEdgePrompt: "Identify entities that are related" };

  it("happy path POST: returns 202 with invoke result", async () => {
    const invokeResult = { jobId: "job-1", status: "queued", estimatedNodes: 100, dryRun: false };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, VALID_BODY);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'infer_semantic_relationships' and surface 'api'", async () => {
    await authPost(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("infer_semantic_relationships");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });
});

// ── semantic.relationship.suggest ────────────────────────────────────────────

describe("semantic.relationship.suggest route", () => {
  const PATH = "/semantic-relationships/suggest";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { suggestions: [], total: 0, limit: 50 };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'suggest_semantic_relationships' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("suggest_semantic_relationships");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?confidenceMin=0.3&confidenceMax=0.8 → parsed and passed to invoke", async () => {
    await authGet(`${PATH}?confidenceMin=0.3&confidenceMax=0.8`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.confidenceMin).toBe(0.3);
    expect(body.confidenceMax).toBe(0.8);
  });
});

// ── semantic.relationship.approve ─────────────────────────────────────────────

describe("semantic.relationship.approve route", () => {
  const EDGE_ID = "edge-xyz";
  const PATH = `/semantic-relationships/${EDGE_ID}/decide`;

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { edgeId: EDGE_ID, decision: "approve" };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await authPost(PATH, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'approve_semantic_relationship' and surface 'api'", async () => {
    await authPost(PATH, { decision: "reject" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("approve_semantic_relationship");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes edgeId from path param and decision from body", async () => {
    await authPost(PATH, { decision: "approve", comment: "Looks correct" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.edgeId).toBe(EDGE_ID);
    expect(body.decision).toBe("approve");
    expect(body.comment).toBe("Looks correct");
  });

  it("invalid decision → 400, invoke not called", async () => {
    const res = await authPost(PATH, { decision: "maybe" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
