/**
 * Unit tests for the thin dispatch routes added by the eval, market-router,
 * subagent-fanout, and per-workspace-preferences merges. Each is a one-line
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

describe("eval dataset routes", () => {
  it("POST /eval/datasets → 201 create", async () => {
    mocks.invoke.mockResolvedValue({ dataset: { publicId: "eds_1" } });
    const res = await app.fetch(post("/eval/datasets", { name: "Golden set" }));
    expect(res.status).toBe(201);
    expect(invokedCapability()).toBe("create_dataset");
    expect(invokedInput().name).toBe("Golden set");
  });

  it("POST /eval/datasets rejects a blank name with 400", async () => {
    const res = await app.fetch(post("/eval/datasets", { name: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("GET /eval/datasets → 200 list", async () => {
    mocks.invoke.mockResolvedValue({ datasets: [] });
    const res = await app.fetch(get("/eval/datasets"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_datasets");
  });

  it("GET /eval/datasets/get coerces the limit query param", async () => {
    mocks.invoke.mockResolvedValue({ items: [], nextCursor: null });
    const res = await app.fetch(
      get("/eval/datasets/get?datasetPublicId=eds_1&limit=25&cursor=c1"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_dataset");
    const input = invokedInput();
    expect(input.datasetPublicId).toBe("eds_1");
    expect(input.limit).toBe(25);
    expect(input.cursor).toBe("c1");
  });

  it("GET /eval/datasets/get without a datasetPublicId → 400", async () => {
    const res = await app.fetch(get("/eval/datasets/get"));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("POST /eval/datasets/items → 201 add", async () => {
    mocks.invoke.mockResolvedValue({ added: 1 });
    const res = await app.fetch(
      post("/eval/datasets/items", {
        datasetPublicId: "eds_1",
        items: [{ input: "What is 2+2?" }],
      }),
    );
    expect(res.status).toBe(201);
    expect(invokedCapability()).toBe("add_dataset_item");
    expect(Array.isArray(invokedInput().items)).toBe(true);
  });

  it("POST /eval/datasets/items rejects an empty items array with 400", async () => {
    const res = await app.fetch(
      post("/eval/datasets/items", { datasetPublicId: "eds_1", items: [] }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("POST /eval/datasets/from-traces → 201 with defaulted sinceHours/limit", async () => {
    mocks.invoke.mockResolvedValue({
      dataset: { publicId: "eds_2" },
      captured: 5,
    });
    const res = await app.fetch(
      post("/eval/datasets/from-traces", { name: "From traces" }),
    );
    expect(res.status).toBe(201);
    expect(invokedCapability()).toBe("create_trace_dataset");
    const input = invokedInput();
    expect(input.sinceHours).toBe(24 * 7);
    expect(input.limit).toBe(50);
  });
});

describe("eval run routes", () => {
  it("POST /eval/runs → 200 start (model target)", async () => {
    mocks.invoke.mockResolvedValue({ run: { publicId: "erun_1" } });
    const res = await app.fetch(
      post("/eval/runs", {
        datasetPublicId: "eds_1",
        target: { kind: "model", model: "openai/gpt-4o-mini" },
      }),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("start_eval_run");
    expect(invokedInput().passThreshold).toBe(0.7); // schema default applied
  });

  it("POST /eval/runs rejects a missing datasetPublicId with 400", async () => {
    const res = await app.fetch(
      post("/eval/runs", { target: { kind: "model" } }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("GET /eval/runs/status → 200", async () => {
    mocks.invoke.mockResolvedValue({ status: "running" });
    const res = await app.fetch(get("/eval/runs/status?runPublicId=erun_1"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_eval_status");
    expect(invokedInput().runPublicId).toBe("erun_1");
  });

  it("GET /eval/runs/status without runPublicId → 400", async () => {
    const res = await app.fetch(get("/eval/runs/status"));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("GET /eval/runs/get → 200", async () => {
    mocks.invoke.mockResolvedValue({ run: {}, items: [] });
    const res = await app.fetch(get("/eval/runs/get?runPublicId=erun_1"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_eval_run");
  });
});

// ── agent introspection routes (thin getters + typed 404s) ───────────────────

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

describe("agent.file_lock.list route", () => {
  it("GET /agent/file/lock/list forwards path/owner/repo filters", async () => {
    mocks.invoke.mockResolvedValue({ locks: [] });
    const res = await app.fetch(
      get("/agent/file/lock/list?path=src/index.ts&owner=acme&repo=platform"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_file_locks");
    const input = invokedInput();
    expect(input.path).toBe("src/index.ts");
    expect(input.owner).toBe("acme");
    expect(input.repo).toBe("platform");
  });

  it("GET /agent/file/lock/list with no filters passes an empty input", async () => {
    mocks.invoke.mockResolvedValue({ locks: [] });
    const res = await app.fetch(get("/agent/file/lock/list"));
    expect(res.status).toBe(200);
    expect(invokedInput()).toEqual({});
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

describe("agent subagent result / siblings routes", () => {
  it("GET /agent/subagent/result/:runId → 200", async () => {
    mocks.invoke.mockResolvedValue({ result: {} });
    const res = await app.fetch(get("/agent/subagent/result/run_1"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_subagent_result");
    expect(invokedInput().runId).toBe("run_1");
  });

  it("GET /agent/subagent/result/:runId → 404 for an unknown run", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "subagent_run_not_found" }),
    );
    const res = await app.fetch(get("/agent/subagent/result/run_missing"));
    expect(res.status).toBe(404);
  });

  it("GET /agent/subagent/siblings/:runId → 200", async () => {
    mocks.invoke.mockResolvedValue({ siblings: [] });
    const res = await app.fetch(get("/agent/subagent/siblings/run_1"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_subagent_siblings");
  });

  it("GET /agent/subagent/siblings/:runId → 404 for an unknown run", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "subagent_run_not_found" }),
    );
    const res = await app.fetch(get("/agent/subagent/siblings/run_missing"));
    expect(res.status).toBe(404);
  });
});

// ── telemetry error-cluster route ────────────────────────────────────────────

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

describe("skill-version + document read routes", () => {
  it("GET /skill/version/get forwards skill_id + version_id", async () => {
    mocks.invoke.mockResolvedValue({ version: {} });
    const res = await app.fetch(
      get("/skill/version/get?skill_id=skl_1&version_id=slv_1"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("get_skill_version");
    const input = invokedInput();
    expect(input.skill_id).toBe("skl_1");
    expect(input.version_id).toBe("slv_1");
  });

  it("GET /skill/version/list coerces limit + offset when present", async () => {
    mocks.invoke.mockResolvedValue({ versions: [] });
    const res = await app.fetch(
      get("/skill/version/list?skill_id=skl_1&limit=10&offset=5"),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("list_skill_versions");
    const input = invokedInput();
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(5);
  });

  it("GET /skill/version/list applies schema defaults when limit/offset are absent", async () => {
    mocks.invoke.mockResolvedValue({ versions: [] });
    const res = await app.fetch(get("/skill/version/list?skill_id=skl_1"));
    expect(res.status).toBe(200);
    const input = invokedInput();
    expect(input.limit).toBe(20); // schema default
    expect(input.offset).toBe(0);
  });

  it("GET /skill/version/get leaves the optional version_id absent", async () => {
    mocks.invoke.mockResolvedValue({ version: null });
    const res = await app.fetch(get("/skill/version/get"));
    expect(res.status).toBe(200);
    const input = invokedInput();
    expect(input.skill_id).toBe("");
    expect(input.version_id).toBeUndefined();
  });

  it("GET /document/read forwards the document_id", async () => {
    mocks.invoke.mockResolvedValue({ document: {} });
    const res = await app.fetch(get("/document/read?document_id=doc_1"));
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("read_document");
    expect(invokedInput().document_id).toBe("doc_1");
  });

  it("GET /document/read falls back to an empty document_id when absent", async () => {
    mocks.invoke.mockResolvedValue({ document: null });
    const res = await app.fetch(get("/document/read"));
    expect(res.status).toBe(200);
    expect(invokedInput().document_id).toBe("");
  });
});

// ── subagent fanout aggregate (typed 404) ────────────────────────────────────

describe("agent.subagent.aggregate route", () => {
  it("POST /agent/subagent/aggregate → 200 with defaulted timeout/includeOutputs", async () => {
    mocks.invoke.mockResolvedValue({
      fanoutId: "fan_1",
      status: "completed",
      children: [],
    });
    const res = await app.fetch(
      post("/agent/subagent/aggregate", { fanoutId: "fan_1" }),
    );
    expect(res.status).toBe(200);
    expect(invokedCapability()).toBe("aggregate_subagents");
    const input = invokedInput();
    expect(input.timeoutMs).toBe(5 * 60 * 1000); // schema default
    expect(input.includeOutputs).toBe(false);
  });

  it("POST /agent/subagent/aggregate → 404 for an unknown fanout (typed error)", async () => {
    mocks.invoke.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "fanout_not_found" }),
    );
    const res = await app.fetch(
      post("/agent/subagent/aggregate", { fanoutId: "fan_missing" }),
    );
    expect(res.status).toBe(404);
  });

  it("POST /agent/subagent/aggregate → 500 for an unrelated error", async () => {
    mocks.invoke.mockRejectedValue(new Error("neo4j unreachable"));
    const res = await app.fetch(
      post("/agent/subagent/aggregate", { fanoutId: "fan_1" }),
    );
    expect(res.status).toBe(500);
    expect(mocks.invoke).toHaveBeenCalled();
  });
});
