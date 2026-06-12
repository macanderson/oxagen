/**
 * Unit tests for graph route handlers:
 *   graph.cypher, graph.stats, graph.node.list, graph.node.get,
 *   graph.node.delete, graph.node.search, graph.node.upsert,
 *   graph.edge.delete, graph.edge.upsert
 *
 * Pattern: mock at the adapter seam (@oxagen/auth, @oxagen/oxagen/kernel,
 * @oxagen/billing, @oxagen/handlers, middleware/logger), assert happy path
 * forwards invoke result as JSON, invoke called once with correct contract
 * name + parsed input + surface "api", cover route-specific parsing edge
 * cases and validation errors.
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

async function authDelete(path: string, body?: unknown): Promise<Response> {
  return app.fetch(makeRequest(`${BASE}${path}`, {
    method: "DELETE",
    headers: { authorization: bearerHeader("oxk_key"), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

// ── graph.cypher ──────────────────────────────────────────────────────────────

describe("graph.cypher route", () => {
  const PATH = "/graph/cypher";

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { records: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authPost(PATH, { query: "MATCH (n) RETURN n LIMIT 10" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.cypher' and surface 'api'", async () => {
    await authPost(PATH, { query: "MATCH (n) RETURN n" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.cypher");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes query and optional fields to invoke", async () => {
    await authPost(PATH, {
      query: "MATCH (n:Person) RETURN n",
      nlQuery: true,
      params: { name: "Alice" },
    });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.query).toBe("MATCH (n:Person) RETURN n");
    expect(body.nlQuery).toBe(true);
    expect(body.params).toEqual({ name: "Alice" });
  });

  it("empty query string → 400, invoke not called", async () => {
    const res = await authPost(PATH, { query: "" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing query field → 400, invoke not called", async () => {
    const res = await authPost(PATH, { nlQuery: true });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── graph.stats ───────────────────────────────────────────────────────────────

describe("graph.stats route", () => {
  const PATH = "/graph/stats";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { nodeCount: 42, edgeCount: 10 };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.stats' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.stats");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("no query params → includeByType defaults to false", async () => {
    await authGet(PATH);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.includeByType).toBe(false);
  });

  it("?includeByType=true → passes includeByType: true to invoke", async () => {
    await authGet(`${PATH}?includeByType=true`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.includeByType).toBe(true);
  });
});

// ── graph.node.list ───────────────────────────────────────────────────────────

describe("graph.node.list route", () => {
  const PATH = "/graph/nodes";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { nodes: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.node.list' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.node.list");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("no query params → optional labels/sourceId/query are undefined; limit/offset use schema defaults", async () => {
    await authGet(PATH);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.labels).toBeUndefined();
    expect(body.sourceId).toBeUndefined();
    expect(body.query).toBeUndefined();
    // The contract schema applies .default(50) and .default(0)
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("?labels=Person,Company → splits into array and passes to invoke", async () => {
    await authGet(`${PATH}?labels=Person,Company`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.labels).toEqual(["Person", "Company"]);
  });

  it("?limit=20&offset=5 → parses numbers and passes to invoke", async () => {
    await authGet(`${PATH}?limit=20&offset=5`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(5);
  });

  it("?query=alice → passes query string to invoke", async () => {
    await authGet(`${PATH}?query=alice`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.query).toBe("alice");
  });

  it("?sourceId=src-123 → passes sourceId to invoke", async () => {
    await authGet(`${PATH}?sourceId=src-123`);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.sourceId).toBe("src-123");
  });
});

// ── graph.node.get ────────────────────────────────────────────────────────────

describe("graph.node.get route", () => {
  const nodeId = "node-abc-123";
  const PATH = `/graph/node/get/${nodeId}`;

  it("happy path GET /:nodeId: returns 200 with invoke result", async () => {
    const invokeResult = { node: { id: nodeId, label: "Person" } };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authGet(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.node.get' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.node.get");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes nodeId from path param to invoke", async () => {
    await authGet(PATH);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.nodeId).toBe(nodeId);
  });
});

// ── graph.node.delete ─────────────────────────────────────────────────────────

describe("graph.node.delete route", () => {
  const nodeId = "node-del-456";
  const PATH = `/graph/node/delete/${nodeId}`;

  it("happy path DELETE /:nodeId: returns 200 with invoke result", async () => {
    const invokeResult = { deleted: true };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authDelete(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.node.delete' and surface 'api'", async () => {
    await authDelete(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.node.delete");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes nodeId from path param to invoke", async () => {
    await authDelete(PATH);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.nodeId).toBe(nodeId);
  });
});

// ── graph.node.search ─────────────────────────────────────────────────────────

describe("graph.node.search route", () => {
  const PATH = "/graph/node/search";

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { nodes: [{ id: "n1", label: "Person" }] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authPost(PATH, { query: "Alice" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.node.search' and surface 'api'", async () => {
    await authPost(PATH, { query: "search term" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.node.search");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes query, labels, and limit to invoke", async () => {
    await authPost(PATH, { query: "Bob", labels: ["Person"], limit: 5 });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.query).toBe("Bob");
    expect(body.labels).toEqual(["Person"]);
    expect(body.limit).toBe(5);
  });

  it("empty query string → 400, invoke not called", async () => {
    const res = await authPost(PATH, { query: "" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing query field → 400, invoke not called", async () => {
    const res = await authPost(PATH, { labels: ["Person"] });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── graph.node.upsert ─────────────────────────────────────────────────────────

describe("graph.node.upsert route", () => {
  const PATH = "/graph/node/upsert";
  const VALID_BODY = {
    label: "Person",
    displayName: "Alice Smith",
    description: "A test person node",
    properties: { age: 30 },
  };

  it("happy path POST: returns 201 with invoke result", async () => {
    const invokeResult = { nodeId: "node-new-1", label: "Person" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authPost(PATH, VALID_BODY);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.node.upsert' and surface 'api'", async () => {
    await authPost(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.node.upsert");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes label, displayName, description, properties to invoke", async () => {
    await authPost(PATH, VALID_BODY);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.label).toBe("Person");
    expect(body.displayName).toBe("Alice Smith");
    expect(body.description).toBe("A test person node");
    expect(body.properties).toEqual({ age: 30 });
  });

  it("empty label → 400, invoke not called", async () => {
    const res = await authPost(PATH, { ...VALID_BODY, label: "" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("empty displayName → 400, invoke not called", async () => {
    const res = await authPost(PATH, { ...VALID_BODY, displayName: "" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing required fields → 400, invoke not called", async () => {
    const res = await authPost(PATH, { description: "no label or displayName" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── graph.edge.delete ─────────────────────────────────────────────────────────

describe("graph.edge.delete route", () => {
  const PATH = "/graph/edge/delete";
  const VALID_BODY = {
    fromNodeId: "node-from-1",
    toNodeId: "node-to-1",
    edgeType: "RELATED_TO",
  };

  it("happy path DELETE: returns 200 with invoke result", async () => {
    const invokeResult = { deleted: true };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authDelete(PATH, VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.edge.delete' and surface 'api'", async () => {
    await authDelete(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.edge.delete");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes fromNodeId, toNodeId, edgeType to invoke", async () => {
    await authDelete(PATH, VALID_BODY);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fromNodeId).toBe("node-from-1");
    expect(body.toNodeId).toBe("node-to-1");
    expect(body.edgeType).toBe("RELATED_TO");
  });

  it("invalid edgeType → 400, invoke not called", async () => {
    const res = await authDelete(PATH, { ...VALID_BODY, edgeType: "INVALID_EDGE" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing fromNodeId → 400, invoke not called", async () => {
    const res = await authDelete(PATH, { toNodeId: "node-to-1", edgeType: "RELATED_TO" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("each valid GRAPH_EDGE_TYPE is accepted", async () => {
    const edgeTypes = [
      "RELATED_TO",
      "PART_OF",
      "CAUSED_BY",
      "REFERENCES",
      "SIMILAR_TO",
      "DEPENDS_ON",
      "CREATED_BY",
      "MENTIONS",
    ] as const;

    for (const edgeType of edgeTypes) {
      vi.clearAllMocks();
      mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
      mocks.invoke.mockResolvedValue({ deleted: true });

      const res = await authDelete(PATH, {
        fromNodeId: "node-a",
        toNodeId: "node-b",
        edgeType,
      });
      expect(res.status).toBe(200);
      expect(mocks.invoke).toHaveBeenCalledOnce();
    }
  });
});

// ── graph.edge.upsert ─────────────────────────────────────────────────────────

describe("graph.edge.upsert route", () => {
  const PATH = "/graph/edge/upsert";
  const VALID_BODY = {
    fromNodeId: "node-from-2",
    toNodeId: "node-to-2",
    edgeType: "DEPENDS_ON",
    properties: { weight: "0.9" },
  };

  it("happy path POST: returns 201 with invoke result", async () => {
    const invokeResult = { edgeId: "edge-new-1", edgeType: "DEPENDS_ON" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await authPost(PATH, VALID_BODY);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'graph.edge.upsert' and surface 'api'", async () => {
    await authPost(PATH, VALID_BODY);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("graph.edge.upsert");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes fromNodeId, toNodeId, edgeType, properties to invoke", async () => {
    await authPost(PATH, VALID_BODY);
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fromNodeId).toBe("node-from-2");
    expect(body.toNodeId).toBe("node-to-2");
    expect(body.edgeType).toBe("DEPENDS_ON");
    expect(body.properties).toEqual({ weight: "0.9" });
  });

  it("invalid edgeType → 400, invoke not called", async () => {
    const res = await authPost(PATH, { ...VALID_BODY, edgeType: "NOT_A_TYPE" });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing toNodeId → 400, invoke not called", async () => {
    const res = await authPost(PATH, {
      fromNodeId: "node-from-2",
      edgeType: "DEPENDS_ON",
    });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("optional properties field omitted → invoke still called successfully", async () => {
    const res = await authPost(PATH, {
      fromNodeId: "node-from-2",
      toNodeId: "node-to-2",
      edgeType: "MENTIONS",
    });
    expect(res.status).toBe(201);
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
});
