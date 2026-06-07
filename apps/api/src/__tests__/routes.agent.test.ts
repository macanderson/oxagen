/**
 * Unit tests for agent route handlers:
 *   agent.approval.resolve, agent.mcp.list, agent.mcp.register,
 *   agent.memory.recall, agent.memory.write, agent.plan.approve,
 *   agent.skill.list, agent.task.background.cancel,
 *   agent.task.background.read, agent.task.background.start,
 *   agent.tool.list
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

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  verifyStripeSignature: mocks.verifyStripeSignature,
  processStripeEvent: mocks.processStripeEvent,
  bootstrapBillingRuntime: vi.fn(),
}));

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
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";

function orgReq(
  path: string,
  init?: RequestInit,
): Request {
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

// ── agent.approval.resolve ──────────────────────────────────────────────────

describe("agent.approval.resolve route", () => {
  const PATH = "/agent/approvals/resolve";

  it("happy path: forwards invoke result as 200 JSON", async () => {
    const invokeResult = { approvalId: "appr-1", resolution: "approved" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { approvalId: "appr-1", decision: "approved" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke once with contract name 'agent.approval.resolve' and surface 'api'", async () => {
    await app.fetch(
      post(PATH, { approvalId: "appr-1", decision: "denied", note: "bad" }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.approval.resolve");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes parsed body fields to invoke", async () => {
    await app.fetch(
      post(PATH, { approvalId: "appr-2", decision: "denied", note: "nope" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.approvalId).toBe("appr-2");
    expect(body.decision).toBe("denied");
    expect(body.note).toBe("nope");
  });

  it("invalid decision enum → Zod parse error → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { approvalId: "x", decision: "maybe" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
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

  it("calls invoke with 'agent.mcp.list' and empty input", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.mcp.list");
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

  it("calls invoke with 'agent.mcp.register' and correct fields", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.mcp.register");
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

  it("calls invoke with 'agent.memory.recall'", async () => {
    await app.fetch(post(PATH, { query: "test query" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.memory.recall");
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
    weight: "high",
    kind: "constraint",
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

  it("calls invoke with 'agent.memory.write'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.memory.write");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("invalid weight enum → 400", async () => {
    const res = await app.fetch(
      post(PATH, { ...VALID_BODY, weight: "extreme" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.plan.approve ─────────────────────────────────────────────────────

describe("agent.plan.approve route", () => {
  const PATH = "/agent/plans/approve";

  it("happy path: 200 with plan result", async () => {
    const invokeResult = { planId: "plan-1", status: "approved" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { planId: "plan-1", decision: "approve" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'agent.plan.approve'", async () => {
    await app.fetch(post(PATH, { planId: "plan-1", decision: "deny" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.plan.approve");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.planId).toBe("plan-1");
    expect(body.decision).toBe("deny");
  });

  it("invalid decision → 400", async () => {
    const res = await app.fetch(
      post(PATH, { planId: "plan-1", decision: "maybe" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.skill.list ───────────────────────────────────────────────────────

describe("agent.skill.list route", () => {
  const PATH = "/agent/skills";

  it("happy path GET: 200 with skills", async () => {
    const invokeResult = { skills: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'agent.skill.list' and empty input when no filter", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.skill.list");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });

  it("?filter=builtin → passes filter to invoke", async () => {
    await app.fetch(
      makeRequest(`${BASE}/agent/skills?filter=builtin`, {
        headers: { authorization: bearerHeader("oxk_key") },
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.filter).toBe("builtin");
  });

  it("no filter param → invoke receives no filter property", async () => {
    await app.fetch(get(PATH));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.filter).toBeUndefined();
  });
});

// ── agent.task.background.cancel ──────────────────────────────────────────

describe("agent.task.background.cancel route", () => {
  const PATH = "/agent/tasks/cancel";

  it("happy path: 200", async () => {
    const invokeResult = {
      taskId: "task-1",
      status: "cancelled",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { taskId: "task-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'agent.task.background.cancel'", async () => {
    await app.fetch(post(PATH, { taskId: "task-1", reason: "user cancelled" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.task.background.cancel");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.taskId).toBe("task-1");
    expect(body.reason).toBe("user cancelled");
  });

  it("missing taskId → 400", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.task.background.read ────────────────────────────────────────────

describe("agent.task.background.read route", () => {
  const taskId = "task-abc-123";
  const PATH = `/agent/tasks/${taskId}`;

  it("happy path GET /:taskId: 200 with task", async () => {
    const invokeResult = {
      taskId,
      kind: "research",
      status: "completed",
      label: null,
      resultPayload: null,
      failureReason: null,
      createdAt: "2024-01-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'agent.task.background.read' and taskId from path param", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.task.background.read");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.taskId).toBe(taskId);
  });
});

// ── agent.task.background.start ───────────────────────────────────────────

describe("agent.task.background.start route", () => {
  const PATH = "/agent/tasks";
  const VALID_BODY = { kind: "research", payload: { topic: "AI" } };

  it("happy path: returns 202", async () => {
    const invokeResult = { taskId: "task-1", inngestRunId: "inn-1" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'agent.task.background.start'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.task.background.start");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.kind).toBe("research");
  });

  it("missing kind → 400", async () => {
    const res = await app.fetch(post(PATH, { payload: {} }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.tool.list ────────────────────────────────────────────────────────

describe("agent.tool.list route", () => {
  const PATH = "/agent/tools";

  it("happy path POST with body: 200", async () => {
    const invokeResult = { tools: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { includeExternal: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'agent.tool.list'", async () => {
    await app.fetch(post(PATH, { includeExternal: false }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("agent.tool.list");
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
