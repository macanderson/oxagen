/**
 * Unit tests for graph route handlers:
 *   graph.stats, graph.node.list, graph.node.get, graph.node.search
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
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
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
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      headers: { authorization: bearerHeader("oxk_key") },
    }),
  );
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

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

  it("calls invoke once with contract name 'get_graph_stats' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_graph_stats");
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

  it("calls invoke once with contract name 'list_nodes' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_nodes");
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

  it("calls invoke once with contract name 'get_node' and surface 'api'", async () => {
    await authGet(PATH);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_node");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes nodeId from path param to invoke", async () => {
    await authGet(PATH);
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

  it("calls invoke once with contract name 'search_nodes' and surface 'api'", async () => {
    await authPost(PATH, { query: "search term" });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("search_nodes");
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
