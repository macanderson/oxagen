/**
 * Unit tests for agent route handlers not covered by routes.agent.test.ts:
 *   agent.code.execute, agent.compose, agent.execution.record,
 *   agent.mcp.consent.list, agent.mcp.consent.resolve,
 *   agent.mcp.delete, agent.mcp.set_enabled,
 *   agent.memory.list, agent.memory.policy.read, agent.memory.policy.write,
 *   agent.plan.create, agent.skill.load,
 *   agent.subagent.aggregate, agent.subagent.cancel,
 *   agent.subagent.dispatch, agent.subagent.logs
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

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── agent.code.execute ────────────────────────────────────────────────────────

describe("agent.code.execute route", () => {
  const PATH = "/agent/code/execute";
  const VALID_BODY = { language: "python", code: "print('hello')" };

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { stdout: "hello\n", stderr: "", exitCode: 0 };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'execute_code' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("execute_code");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes language and code to invoke", async () => {
    await app.fetch(post(PATH, { language: "node", code: "console.log(42)" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.language).toBe("node");
    expect(body.code).toBe("console.log(42)");
  });

  it("invalid language → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { language: "ruby", code: "puts 1" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("empty code → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { language: "python", code: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.compose ─────────────────────────────────────────────────────────────

describe("agent.compose route", () => {
  const PATH = "/agent/compose";
  const VALID_BODY = { goal: "Summarize the latest quarterly report" };

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = { summary: "done", steps: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'run_capability_chain' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("run_capability_chain");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes goal field through to invoke", async () => {
    await app.fetch(post(PATH, { goal: "Build a product roadmap" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.goal).toBe("Build a product roadmap");
  });

  it("empty goal → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { goal: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.execution.record ────────────────────────────────────────────────────

describe("agent.execution.record route", () => {
  const PATH = "/agent/execution/record";
  const VALID_BODY = {
    agentId: "11111111-1111-1111-1111-111111111111",
    agentVersionId: "22222222-2222-2222-2222-222222222222",
    originType: "chat",
    originId: "33333333-3333-3333-3333-333333333333",
    status: "completed",
    inputPayload: { task: "run report" },
  };

  it("happy path POST: returns 200 with invoke result", async () => {
    const invokeResult = {
      executionId: "44444444-4444-4444-4444-444444444444",
      status: "completed",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'record_execution' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("record_execution");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes required fields to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.agentId).toBe(VALID_BODY.agentId);
    expect(body.status).toBe("completed");
    expect(body.originType).toBe("chat");
  });

  it("invalid status enum → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { ...VALID_BODY, status: "unknown_status" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.mcp.consent.list ────────────────────────────────────────────────────

describe("agent.mcp.consent.list route", () => {
  const PATH = "/agent/mcp-consents";
  const VALID_BODY = {};

  it("happy path POST: returns 200 with consent list", async () => {
    const invokeResult = { consents: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_mcp_consents' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_mcp_consents");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("mineOnly=true is forwarded to invoke", async () => {
    await app.fetch(post(PATH, { mineOnly: true }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.mineOnly).toBe(true);
  });
});

// ── agent.mcp.consent.resolve ─────────────────────────────────────────────────

describe("agent.mcp.consent.resolve route", () => {
  const PATH = "/agent/mcp-consents/resolve";
  const VALID_BODY = { approvalId: "appr-consent-1", decision: "granted" };

  it("happy path POST: returns 200", async () => {
    const invokeResult = {
      approvalId: "appr-consent-1",
      resolution: "granted",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'resolve_mcp_consent' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("resolve_mcp_consent");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes approvalId and decision to invoke", async () => {
    await app.fetch(
      post(PATH, {
        approvalId: "appr-2",
        decision: "denied",
        grantAllTools: false,
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.approvalId).toBe("appr-2");
    expect(body.decision).toBe("denied");
    expect(body.grantAllTools).toBe(false);
  });

  it("invalid decision → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { approvalId: "appr-1", decision: "maybe" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.mcp.delete ──────────────────────────────────────────────────────────

describe("agent.mcp.delete route", () => {
  const PATH = "/agent/mcp-servers/delete";

  it("happy path POST: returns 200", async () => {
    const invokeResult = { mcpServerId: "srv-1", deleted: true };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { mcpServerId: "srv-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'delete_mcp_server' and surface 'api'", async () => {
    await app.fetch(post(PATH, { mcpServerId: "srv-1" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_mcp_server");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes mcpServerId to invoke", async () => {
    await app.fetch(post(PATH, { mcpServerId: "srv-abc" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.mcpServerId).toBe("srv-abc");
  });

  it("missing mcpServerId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.mcp.set_enabled ─────────────────────────────────────────────────────

describe("agent.mcp.set_enabled route", () => {
  const PATH = "/agent/mcp-servers/set-enabled";

  it("happy path POST: returns 200", async () => {
    const invokeResult = {
      mcpServerId: "srv-1",
      enabled: false,
      snapshotCount: 3,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { mcpServerId: "srv-1", enabled: false }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'set_mcp_enabled' and surface 'api'", async () => {
    await app.fetch(post(PATH, { mcpServerId: "srv-1", enabled: true }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_mcp_enabled");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes mcpServerId and enabled to invoke", async () => {
    await app.fetch(post(PATH, { mcpServerId: "srv-xyz", enabled: true }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.mcpServerId).toBe("srv-xyz");
    expect(body.enabled).toBe(true);
  });

  it("missing enabled → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { mcpServerId: "srv-1" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.memory.list ─────────────────────────────────────────────────────────

describe("agent.memory.list route", () => {
  const PATH = "/agent/memory/list";

  it("happy path POST with empty body: returns 200", async () => {
    const invokeResult = { memories: [], total: 0 };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_memories' and surface 'api'", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_memories");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes optional filters to invoke", async () => {
    await app.fetch(
      post(PATH, {
        memoryClass: "RULE",
        memoryKind: "gotcha",
        minEnforcement: 50,
        limit: 20,
        offset: 5,
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.memoryClass).toBe("RULE");
    expect(body.memoryKind).toBe("gotcha");
    expect(body.minEnforcement).toBe(50);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(5);
  });

  it("passes the citation sort axis and minCitations floor to invoke", async () => {
    await app.fetch(
      post(PATH, { minCitations: 3, sort: "citationCount", sortDir: "desc" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.minCitations).toBe(3);
    expect(body.sort).toBe("citationCount");
    expect(body.sortDir).toBe("desc");
  });

  it("defaults sort to createdAt/desc when unspecified", async () => {
    await app.fetch(post(PATH, {}));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.sort).toBe("createdAt");
    expect(body.sortDir).toBe("desc");
  });

  it("invalid memoryClass → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { memoryClass: "MAYBE" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid sort axis → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { sort: "sideways" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.memory.policy.read ──────────────────────────────────────────────────

describe("agent.memory.policy.read route", () => {
  const PATH = "/agent/memory/policy";

  it("happy path GET: returns 200 with policy", async () => {
    const invokeResult = { retentionDays: 90, enabled: true };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_memory_policy' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_memory_policy");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes empty input object to invoke", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── agent.memory.policy.write ─────────────────────────────────────────────────

describe("agent.memory.policy.write route", () => {
  const PATH = "/agent/memory/policy";

  it("happy path POST: returns 200", async () => {
    const invokeResult = {
      halfLifeLowDays: 30,
      halfLifeHighDays: 90,
      recallThreshold: 0.1,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { halfLifeLowDays: 30 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'update_memory_policy' and surface 'api'", async () => {
    await app.fetch(post(PATH, { halfLifeHighDays: 60 }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("update_memory_policy");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes partial policy fields to invoke", async () => {
    await app.fetch(post(PATH, { halfLifeLowDays: 14, recallThreshold: 0.5 }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.halfLifeLowDays).toBe(14);
    expect(body.recallThreshold).toBe(0.5);
  });
});

// ── agent.plan.create ─────────────────────────────────────────────────────────

describe("agent.plan.create route", () => {
  const PATH = "/agent/plans";
  const VALID_BODY = {
    goals: ["Deliver quarterly report"],
    tasks: [
      {
        id: "task-1",
        title: "Gather data",
        dependsOn: [],
      },
    ],
  };

  it("happy path POST: returns 200 with plan", async () => {
    const invokeResult = {
      planId: "plan-1",
      status: "draft",
      goals: ["Deliver quarterly report"],
      tasks: VALID_BODY.tasks,
      approvalRequired: true,
      createdAt: "2026-06-28T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_plan' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_plan");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes goals and tasks to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.goals).toEqual(["Deliver quarterly report"]);
    const tasks = body.tasks as { id: string; title: string }[];
    expect(tasks[0]?.id).toBe("task-1");
    expect(tasks[0]?.title).toBe("Gather data");
  });

  it("empty goals array → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { ...VALID_BODY, goals: [] }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("empty tasks array → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { ...VALID_BODY, tasks: [] }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.skill.load ──────────────────────────────────────────────────────────

describe("agent.skill.load route", () => {
  const PATH = "/agent/skills/load";

  it("happy path POST: returns 200 with loaded skill", async () => {
    const invokeResult = {
      skillSlug: "code-review",
      loaded: true,
      versionLoaded: 2,
      body: "# Code Review Skill",
      capabilities: ["code.review"],
      dependencyErrors: [],
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { skillSlug: "code-review" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'load_skill' and surface 'api'", async () => {
    await app.fetch(post(PATH, { skillSlug: "data-analysis" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("load_skill");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes skillSlug and optional version to invoke", async () => {
    await app.fetch(post(PATH, { skillSlug: "coding", version: "^2" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.skillSlug).toBe("coding");
    expect(body.version).toBe("^2");
  });

  it("missing skillSlug → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.subagent.aggregate ──────────────────────────────────────────────────

describe("agent.subagent.aggregate route", () => {
  const PATH = "/agent/subagent/aggregate";

  it("happy path POST: returns 200 with aggregated result", async () => {
    const invokeResult = {
      fanoutId: "fan-1",
      status: "completed",
      totalChildren: 3,
      completedChildren: 3,
      aggregatedData: { count: 3 },
      conflicts: [],
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { fanoutId: "fan-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'aggregate_subagents' and surface 'api'", async () => {
    await app.fetch(post(PATH, { fanoutId: "fan-2" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("aggregate_subagents");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes fanoutId and optional timeoutMs to invoke", async () => {
    await app.fetch(post(PATH, { fanoutId: "fan-3", timeoutMs: 60000 }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fanoutId).toBe("fan-3");
    expect(body.timeoutMs).toBe(60000);
  });

  it("missing fanoutId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.subagent.cancel ─────────────────────────────────────────────────────

describe("agent.subagent.cancel route", () => {
  const fanoutId = "fan-cancel-1";
  const PATH = `/agent/subagent/cancel/${fanoutId}`;

  it("happy path POST /:fanoutId: returns 200 with cancel result", async () => {
    const invokeResult = {
      fanoutId,
      status: "cancelled",
      cancelledChildren: 2,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "POST",
        headers: { authorization: bearerHeader("oxk_key") },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'cancel_subagent' and passes fanoutId from path", async () => {
    await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "POST",
        headers: { authorization: bearerHeader("oxk_key") },
      }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("cancel_subagent");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fanoutId).toBe(fanoutId);
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });
});

// ── agent.subagent.dispatch ───────────────────────────────────────────────────

describe("agent.subagent.dispatch route", () => {
  const PATH = "/agent/subagent/dispatch";
  const VALID_BODY = {
    parentMessageId: "msg-1",
    tasks: [
      { capabilityName: "search_web", input: { query: "AI trends 2026" } },
      { capabilityName: "search_web", input: { query: "LLM pricing 2026" } },
    ],
  };

  it("happy path POST: returns 202 with dispatch result", async () => {
    const invokeResult = {
      fanoutId: "fan-new-1",
      parentMessageId: "msg-1",
      totalTasks: 2,
      status: "pending",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'dispatch_subagent' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("dispatch_subagent");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes parentMessageId and tasks to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.parentMessageId).toBe("msg-1");
    const tasks = body.tasks as { capabilityName: string }[];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.capabilityName).toBe("search_web");
  });

  it("empty tasks array → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { ...VALID_BODY, tasks: [] }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing parentMessageId → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { tasks: [{ capabilityName: "search_web", input: {} }] }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── agent.subagent.logs ───────────────────────────────────────────────────────

describe("agent.subagent.logs route", () => {
  const PATH = "/agent/subagent/logs";

  it("happy path POST: returns 200 with logs asset", async () => {
    const invokeResult = {
      assetId: "ast-1",
      publicId: "pub-1",
      childCount: 3,
      mimeType: "text/markdown",
      sizeBytes: 2048,
      url: "https://example.com/logs.md",
      serveUrl: "https://example.com/serve/logs.md",
      render: { type: "markdown" },
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { fanoutId: "fan-logs-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_subagent_logs' and surface 'api'", async () => {
    await app.fetch(
      post(PATH, { fanoutId: "fan-logs-2", title: "Research Run Logs" }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_subagent_logs");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes fanoutId and optional title to invoke", async () => {
    await app.fetch(post(PATH, { fanoutId: "fan-logs-3", title: "My Run" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.fanoutId).toBe("fan-logs-3");
    expect(body.title).toBe("My Run");
  });

  it("missing fanoutId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
