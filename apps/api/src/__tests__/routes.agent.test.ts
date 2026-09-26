/**
 * Unit tests for agent route handlers:
 *   agent.approval.list, agent.approval.resolve, agent.mcp.list, agent.mcp.register,
 *   agent.memory.recall, agent.memory.write, agent.tool.list
 *
 * Pattern: mock at the adapter seam (@oxagen/auth, @oxagen/oxagen/kernel,
 * @oxagen/billing, @oxagen/handlers, middleware/logger), assert happy path
 * forwards invoke result as JSON, invoke called once with correct contract
 * name + parsed body + surface "api", cover route-specific parsing edge cases.
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
  return {
    ...real,
    invoke: mocks.invoke,
    clearHandlersForTests: vi.fn(),
  };
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

function orgReq(path: string, init?: RequestInit): Request {
  return makeRequest(`${BASE}${path}`, {
    headers: { authorization: bearerHeader("oxk_key") },
    ...init,
  });
}

function post(path: string, body: unknown): Request {
  return orgReq(path, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return orgReq(path, {
    method: "GET",
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── agent.approval.list ─────────────────────────────────────────────────────

describe("agent.approval.list route", () => {
  const PATH = "/agent/approvals/list";

  it("happy path POST: returns 200 with the page invoke returned", async () => {
    const invokeResult = { items: [], nextCursor: null };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'list_approvals', the parsed input and surface 'api'", async () => {
    mocks.invoke.mockResolvedValue({ items: [], nextCursor: null });
    await app.fetch(
      post(PATH, { runId: "arun_0123456789abcdefghjkmn", limit: 5 }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_approvals");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({
      runId: "arun_0123456789abcdefghjkmn",
      limit: 5,
    });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("defaults the page size to 50 when the body omits it", async () => {
    mocks.invoke.mockResolvedValue({ items: [], nextCursor: null });
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({ limit: 50 });
  });

  it("refuses a page size outside 1..100 and an unknown field before invoke", async () => {
    const tooBig = await app.fetch(post(PATH, { limit: 101 }));
    expect(tooBig.status).toBe(400);
    const unknown = await app.fetch(post(PATH, { status: "pending" }));
    expect(unknown.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.approval.list_resolved (#3153) ────────────────────────────────────

describe("agent.approval.list_resolved route", () => {
  const PATH = "/agent/approvals/resolved";

  it("happy path POST: returns 200 with the page invoke returned", async () => {
    const invokeResult = { items: [], nextCursor: null };
    mocks.invoke.mockResolvedValue(invokeResult);
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'list_resolved_approvals', the parsed input and surface 'api'", async () => {
    mocks.invoke.mockResolvedValue({ items: [], nextCursor: null });
    await app.fetch(
      post(PATH, { runId: "arun_0123456789abcdefghjkmn", limit: 5 }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_resolved_approvals");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({
      runId: "arun_0123456789abcdefghjkmn",
      limit: 5,
    });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("refuses a page size outside 1..100 and an unknown field before invoke", async () => {
    const tooBig = await app.fetch(post(PATH, { limit: 101 }));
    expect(tooBig.status).toBe(400);
    const unknown = await app.fetch(post(PATH, { status: "approved" }));
    expect(unknown.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.approval.resolve ──────────────────────────────────────────────────

describe("agent.approval.resolve route", () => {
  const PATH = "/agent/approvals/resolve";
  const PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w0";
  const ROW_UUID = "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c";

  it("happy path: forwards invoke result as 200 JSON", async () => {
    const invokeResult = { approvalId: PUBLIC_ID, resolution: "approved" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { approvalId: PUBLIC_ID, decision: "approved" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'resolve_approval' and surface 'api'", async () => {
    await app.fetch(
      post(PATH, { approvalId: PUBLIC_ID, decision: "denied", note: "bad" }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("resolve_approval");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes parsed body fields to invoke, a uuid id as sent", async () => {
    await app.fetch(
      post(PATH, { approvalId: ROW_UUID, decision: "denied", note: "nope" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.approvalId).toBe(ROW_UUID);
    expect(body.decision).toBe("denied");
    expect(body.note).toBe("nope");
  });

  it("invalid decision enum → Zod parse error → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { approvalId: PUBLIC_ID, decision: "maybe" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("approvalId that is neither apr_… nor a uuid → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { approvalId: "appr-1", decision: "approved" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("an id that matched no pending row → 409 conflict approval_expired", async () => {
    const { HandlerError } = await import("@oxagen/oxagen");
    mocks.invoke.mockRejectedValue(
      new HandlerError({ code: "conflict", reason: "approval_expired" }),
    );
    const res = await app.fetch(
      post(PATH, { approvalId: PUBLIC_ID, decision: "approved" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "conflict", reason: "approval_expired" },
    });
  });
});

// ── agent.mcp.list ──────────────────────────────────────────────────────────

describe("agent.mcp.list route", () => {
  const PATH = "/agent/mcp-servers";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { servers: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_mcp_servers' and empty input", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_mcp_servers");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });
});

// ── agent.mcp.register ─────────────────────────────────────────────────────

describe("agent.mcp.register route", () => {
  const PATH = "/agent/mcp-servers";
  const VALID_BODY = {
    name: "My Server",
    transportType: "streamable-http",
    endpointUrl: "https://example.com/mcp",
  };

  it("happy path POST: returns 201 with invoke result", async () => {
    const invokeResult = {
      mcpServerId: "srv-1",
      healthStatus: "healthy",
      discoveredTools: ["tool1"],
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'register_mcp_server' and correct fields", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("register_mcp_server");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.name).toBe("My Server");
    expect(body.transportType).toBe("streamable-http");
    expect(body.endpointUrl).toBe("https://example.com/mcp");
  });

  it("missing required field → 400", async () => {
    const res = await app.fetch(post(PATH, { name: "oops" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.memory.recall ────────────────────────────────────────────────────

describe("agent.memory.recall route", () => {
  const PATH = "/agent/memory/recall";

  it("happy path: 200 with memories", async () => {
    const invokeResult = { memories: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { query: "what did I learn?" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'recall_memory'", async () => {
    await app.fetch(post(PATH, { query: "test query" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("recall_memory");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes query to invoke", async () => {
    await app.fetch(post(PATH, { query: "my query", limit: 5 }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.query).toBe("my query");
    expect(body.limit).toBe(5);
  });

  it("empty query string → 400", async () => {
    const res = await app.fetch(post(PATH, { query: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.memory.write ─────────────────────────────────────────────────────

describe("agent.memory.write route", () => {
  const PATH = "/agent/memory";
  const VALID_BODY = {
    nodeRef: "node-1",
    memoryClass: "OBSERVATION",
    memoryKind: "constraint",
    lesson: "Always check auth first",
    source: "feature",
  };

  it("happy path: returns 201", async () => {
    const invokeResult = { memoryId: "mem-1", nodeRef: "node-1" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'write_memory'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("write_memory");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("invalid memoryClass enum → 400", async () => {
    const res = await app.fetch(
      post(PATH, { ...VALID_BODY, memoryClass: "MAYBE" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.plan.approve ─────────────────────────────────────────────────────

describe("agent.tool.list route", () => {
  const PATH = "/agent/tools";

  it("happy path POST with body: 200", async () => {
    const invokeResult = { tools: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { includeExternal: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_agent_tools'", async () => {
    await app.fetch(post(PATH, { includeExternal: false }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_agent_tools");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.includeExternal).toBe(false);
  });

  it("optional body (empty body / non-JSON) → uses {} default, 200", async () => {
    // agent.tool.list has: const raw = await c.req.json().catch(() => null)
    // so non-JSON body is fine — defaults used.
    const res = await app.fetch(
      orgReq(PATH, {
        method: "POST",
        headers: { authorization: bearerHeader("oxk_key") },
        body: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("invoke throws → error middleware returns 500", async () => {
    mocks.invoke.mockRejectedValue(new Error("handler failure"));
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(500);
  });
});
