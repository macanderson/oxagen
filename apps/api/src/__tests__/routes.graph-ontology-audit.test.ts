/**
 * Unit tests for graph, ontology, and audit route handlers:
 *   graph.search, ontology.query, ontology.neighbors,
 *   audit.log.query
 *
 * Pattern: mock at the adapter seam, assert the handler forwards invoke result
 * as JSON, invoke called once with the correct contract name + surface "api".
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

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── graph.search ──────────────────────────────────────────────────────────────

describe("graph.search route", () => {
  const PATH = "/graph/search";

  it("happy path POST: returns 200 with search results", async () => {
    const invokeResult = {
      results: [
        {
          nodeId: "n1",
          label: "Person",
          score: 0.95,
          displayName: "Alice",
          kind: "entity",
          snippet: "...",
        },
      ],
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { query: "Alice from engineering" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'search_graph' and surface 'api'", async () => {
    await app.fetch(post(PATH, { query: "search term" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("search_graph");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes query and optional filters to invoke", async () => {
    await app.fetch(
      post(PATH, {
        query: "Bob",
        limit: 5,
        kinds: ["entity"],
        labels: ["Person"],
        isSystem: true,
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.query).toBe("Bob");
    expect(body.limit).toBe(5);
    expect(body.labels).toEqual(["Person"]);
    expect(body.kinds).toBeUndefined();
    expect(body.isSystem).toBeUndefined();
  });

  it("empty query → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { query: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing query → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { limit: 10 }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── ontology.query ────────────────────────────────────────────────────────────

describe("ontology.query route", () => {
  const PATH = "/ontology/query";
  const VALID_BODY = { startNodeId: "node-root-1" };

  it("happy path POST: returns 200 with traversal result", async () => {
    const invokeResult = { nodes: [], edges: [], startNodeId: "node-root-1" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'query_ontology' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("query_ontology");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes startNodeId and optional params to invoke", async () => {
    await app.fetch(
      post(PATH, {
        startNodeId: "node-abc",
        edgeTypes: ["RELATED_TO", "PART_OF"],
        direction: "out",
        maxDepth: 3,
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.startNodeId).toBe("node-abc");
    expect(body.edgeTypes).toEqual(["RELATED_TO", "PART_OF"]);
    expect(body.direction).toBe("out");
    expect(body.maxDepth).toBe(3);
  });

  it("missing startNodeId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { direction: "out" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid edgeType (lowercase) → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { startNodeId: "n1", edgeTypes: ["invalid_edge"] }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── ontology.neighbors ────────────────────────────────────────────────────────

describe("ontology.neighbors route", () => {
  const PATH = "/ontology/neighbors";
  const VALID_BODY = { nodeId: "node-neighbor-1" };

  it("happy path POST: returns 200 with neighbors", async () => {
    const invokeResult = { nodeId: "node-neighbor-1", neighbors: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_ontology_neighbors' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_ontology_neighbors");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes nodeId and optional direction/limit to invoke", async () => {
    await app.fetch(
      post(PATH, { nodeId: "node-abc", direction: "in", limit: 20 }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.nodeId).toBe("node-abc");
    expect(body.direction).toBe("in");
    expect(body.limit).toBe(20);
  });

  it("missing nodeId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { direction: "both" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── audit.log.query ───────────────────────────────────────────────────────────

describe("audit.log.query route", () => {
  const PATH = "/audit/log/query";

  it("happy path POST with empty body: returns 200", async () => {
    const invokeResult = {
      events: [],
      total: 0,
      hasMore: false,
      limit: 50,
      offset: 0,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'query_audit_log' and surface 'api'", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("query_audit_log");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes optional filter fields to invoke", async () => {
    const filters = {
      source: "security",
      eventType: "billing.plan_changed",
      actorUserId: "user-123",
      limit: 25,
      offset: 10,
    };
    await app.fetch(post(PATH, filters));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.source).toBe("security");
    expect(body.eventType).toBe("billing.plan_changed");
    expect(body.actorUserId).toBe("user-123");
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(10);
  });

  it("limit over 200 → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { limit: 201 }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("from/to date range fields are forwarded to invoke", async () => {
    const from = "2026-01-01T00:00:00.000Z";
    const to = "2026-06-01T00:00:00.000Z";
    await app.fetch(post(PATH, { from, to }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.from).toBe(from);
    expect(body.to).toBe(to);
  });
});
