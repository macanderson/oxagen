/**
 * Unit tests for the thin dispatch routes added by the market-router, agent
 * trace, and per-workspace-preferences merges. Each is a one-line
 * adapter — parse the request, call invoke(<capability>, …, { surface: "api" }),
 * return the result — so the tests assert the adapter contract:
 *   - a valid request 200/201/202s and forwards the right capability + input,
 *   - malformed input is rejected (400) before invoke() is reached,
 *   - query-param coercion exercises both the present and absent branches,
 *   - the typed not-found errors map to a clean 404, never a 500.
 *
 * The invoke() kernel and the auth seam are mocked (mirroring routes.misc);
 * everything else is the real app wiring.
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
  // Spread the real kernel so error-mapping exports (CapabilityError, used by
  // the error middleware) survive; only invoke() is stubbed.
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

function authHeaders() {
  return { authorization: bearerHeader("oxk_key") };
}

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
}

/** The capability name invoke() was called with (first positional arg). */
function invokedCapability(): unknown {
  return mocks.invoke.mock.calls[0]?.[0];
}
/** The input payload invoke() was called with (second positional arg). */
function invokedInput(): Record<string, unknown> {
  return mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── market-router routes ────────────────────────────────────────────────────

describe("router.policy routes", () => {
  it("GET /router/policy → 200 and invokes get_routing_policy", async () => {
    mocks.invoke.mockResolvedValue({ policy: { mode: "shadow" } });
    const res = await app.fetch(get("/router/policy"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_routing_policy");
  });

  it("POST /router/policy/set → 200, forwarding the merged policy fields", async () => {
    const res = await app.fetch(
      post("/router/policy/set", {
        scope: "workspace",
        mode: "enforce",
        minSamples: 5,
      }),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("set_routing_policy");
    expect(invokedInput().minSamples).toBe(5);
  });

  it("POST /router/policy/set with an empty body still parses (all fields optional)", async () => {
    const res = await app.fetch(post("/router/policy/set", {}));
    expect(res.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("POST /router/policy/set rejects an out-of-range successThreshold with 400", async () => {
    const res = await app.fetch(
      post("/router/policy/set", { successThreshold: 2 }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("router.stats + router.preview routes", () => {
  it("GET /router/stats coerces window_days / min_samples query params", async () => {
    const res = await app.fetch(
      get("/router/stats?task_class=refactor&window_days=14&min_samples=8"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_routing_stats");
    const input = invokedInput();
    expect(input.taskClass).toBe("refactor");
    expect(input.windowDays).toBe(14);
    expect(input.minSamples).toBe(8);
  });

  it("GET /router/stats with no query params omits the optional filters", async () => {
    const res = await app.fetch(get("/router/stats"));
    expect(res.status).toBe(200);
    const input = invokedInput();
    expect(input.taskClass).toBeUndefined();
    expect(input.windowDays).toBeUndefined();
    expect(input.minSamples).toBeUndefined();
  });

  it("POST /router/preview → 200 and invokes preview_routing_decision", async () => {
    const res = await app.fetch(
      post("/router/preview", { prompt: "refactor the auth module" }),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("preview_routing_decision");
    expect(invokedInput().prompt).toBe("refactor the auth module");
  });

  it("POST /router/preview rejects an empty prompt with 400", async () => {
    const res = await app.fetch(post("/router/preview", { prompt: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── eval routes ─────────────────────────────────────────────────────────────

describe("agent.execution.list route", () => {
  it("GET /agent/executions coerces limit and forwards before/status", async () => {
    mocks.invoke.mockResolvedValue({ executions: [] });
    const before = "2026-01-01T00:00:00.000Z"; // `before` is a strict ISO datetime cursor
    const res = await app.fetch(
      get(`/agent/executions?limit=10&before=${before}&status=failed`),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_executions");
    const input = invokedInput();
    expect(input.limit).toBe(10);
    expect(input.before).toBe(before);
    expect(input.status).toBe("failed");
  });

  it("GET /agent/executions with no query params applies the default limit", async () => {
    mocks.invoke.mockResolvedValue({ executions: [] });
    const res = await app.fetch(get("/agent/executions"));
    expect(res.status).toBe(200);
    const input = invokedInput();
    expect(input.limit).toBe(25); // schema default
    expect(input.before).toBeUndefined();
    expect(input.status).toBeUndefined();
  });
});

describe("agent.trace.get route", () => {
  it("GET /agent/trace/:id → 200 on success", async () => {
    mocks.invoke.mockResolvedValue({ trace: { spans: [] } });
    const res = await app.fetch(get("/agent/trace/aex_1"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_execution_trace");
    expect(invokedInput().executionId).toBe("aex_1");
  });

  it("GET /agent/trace/:id → 404 for an unknown execution (typed error)", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "execution_not_found" }),
    );
    const res = await app.fetch(get("/agent/trace/aex_missing"));
    expect(res.status).toBe(404);
  });

  it("GET /agent/trace/:id → 500 for an unrelated error (not swallowed as 404)", async () => {
    mocks.invoke.mockRejectedValue(new Error("clickhouse timeout"));
    const res = await app.fetch(get("/agent/trace/aex_1"));
    expect(res.status).toBe(500);
  });
});

describe("agent.debug.trace route", () => {
  it("GET /agent/debug/trace/:id coerces depth and summarize=true", async () => {
    mocks.invoke.mockResolvedValue({ frame: {} });
    const res = await app.fetch(
      get("/agent/debug/trace/aex_1?summarize=true&depth=3"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("debug_execution");
    const input = invokedInput();
    expect(input.summarize).toBe(true);
    expect(input.depth).toBe(3);
  });

  it("GET /agent/debug/trace/:id defaults summarize to undefined without the query", async () => {
    mocks.invoke.mockResolvedValue({ frame: {} });
    const res = await app.fetch(get("/agent/debug/trace/aex_1"));
    expect(res.status).toBe(200);
    expect(invokedInput().summarize).toBeUndefined();
  });

  it("GET /agent/debug/trace/:id → 404 for an unknown execution", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "execution_not_found" }),
    );
    const res = await app.fetch(get("/agent/debug/trace/aex_missing"));
    expect(res.status).toBe(404);
  });
});

describe("telemetry.error.cluster route", () => {
  it("GET /telemetry/error/cluster coerces sinceHours / limit and forwards filters", async () => {
    mocks.invoke.mockResolvedValue({ clusters: [], totalErrors: 0 });
    const res = await app.fetch(
      get(
        "/telemetry/error/cluster?sinceHours=48&severity=error&source=api&limit=25",
      ),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_error_clusters");
    const input = invokedInput();
    expect(input.sinceHours).toBe(48);
    expect(input.severity).toBe("error");
    expect(input.limit).toBe(25);
  });

  it("GET /telemetry/error/cluster with no query params omits every optional field", async () => {
    mocks.invoke.mockResolvedValue({ clusters: [] });
    const res = await app.fetch(get("/telemetry/error/cluster"));
    expect(res.status).toBe(200);
    const input = invokedInput();
    expect(input.sinceHours).toBeUndefined();
    expect(input.limit).toBeUndefined();
  });
});

// ── per-(user, workspace) preference routes ──────────────────────────────────

describe("user.workspace_preferences routes", () => {
  it("GET /user/workspace-preferences → 200", async () => {
    mocks.invoke.mockResolvedValue({ preferences: {} });
    const res = await app.fetch(get("/user/workspace-preferences"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_workspace_user_preferences");
  });

  it("POST /user/workspace-preferences → 200 write", async () => {
    mocks.invoke.mockResolvedValue({
      preferences: { defaultAgentId: "agt_1" },
    });
    const res = await app.fetch(
      post("/user/workspace-preferences", {
        defaultAgentId: "agt_1",
        markRepoPrompted: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("update_workspace_user_preferences");
    expect(invokedInput().defaultAgentId).toBe("agt_1");
  });
});

// ── conversation asset routes ────────────────────────────────────────────────

describe("conversation files / export routes", () => {
  it("GET /conversations/:id/files coerces the limit and forwards the kind filter", async () => {
    mocks.invoke.mockResolvedValue({ files: [], nextCursor: null });
    const res = await app.fetch(
      get("/conversations/cnv_1/files?kind=image&limit=20"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_conversation_files");
    const input = invokedInput();
    expect(input.conversationId).toBe("cnv_1");
    expect(input.kind).toBe("image");
    expect(input.limit).toBe(20);
  });

  it("GET /conversations/:id/files with no query params defaults the cursor to null", async () => {
    mocks.invoke.mockResolvedValue({ files: [], nextCursor: null });
    const res = await app.fetch(get("/conversations/cnv_1/files"));
    expect(res.status).toBe(200);
    expect(invokedInput().cursor).toBeNull();
  });

  it("GET /conversations/:id/export → 200 with the required format", async () => {
    mocks.invoke.mockResolvedValue({ content: "# Chat", format: "markdown" });
    const res = await app.fetch(
      get("/conversations/cnv_1/export?format=markdown"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("export_conversation");
    expect(invokedInput().format).toBe("markdown");
  });

  it("GET /conversations/:id/export rejects a missing/invalid format with 400", async () => {
    const res = await app.fetch(get("/conversations/cnv_1/export?format=csv"));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── privacy export (POST initiation path) ────────────────────────────────────

describe("privacy.data.export route", () => {
  it("POST /privacy/export → 202 accepted for a valid scope", async () => {
    mocks.invoke.mockResolvedValue({ exportId: "pex_1", status: "pending" });
    const res = await app.fetch(post("/privacy/export", { scope: "user" }));
    expect(res.status).toBe(202);
    expect(invokedCapability()).toBe("export_data");
    expect(invokedInput().scope).toBe("user");
  });

  it("POST /privacy/export rejects an out-of-enum scope with 400", async () => {
    const res = await app.fetch(
      post("/privacy/export", { scope: "everything" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── skill-version + document read routes (nullish query defaults) ────────────
