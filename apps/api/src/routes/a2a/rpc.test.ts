import { describe, expect, it, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  createTask: vi.fn(),
  loadTask: vi.fn(),
  updateTask: vi.fn(),
  loadContextHistory: vi.fn(async () => []),
  runA2ATask: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("./task-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("./task-store")>();
  return {
    ...real, // keep the real (pure) toA2ATask
    createTask: h.createTask,
    loadTask: h.loadTask,
    updateTask: h.updateTask,
    loadContextHistory: h.loadContextHistory,
  };
});
vi.mock("./bridge", () => ({ runA2ATask: h.runA2ATask }));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: h.invoke }));

import { a2aRpcRoute } from "./rpc";
import type { AppEnv } from "../../app";

// A minimal app that stamps org+workspace scope the way authMiddleware would.
function makeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("orgId", "org_1");
    c.set("workspaceId", "ws_1");
    c.set("apiKeyId", "key_1");
    c.set("userId", null);
    c.set("requestId", "req_1");
    await next();
  });
  app.route("/", a2aRpcRoute);
  return app;
}

function rpc(body: unknown) {
  return makeApp().request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const rowCompleted = {
  publicId: "a2a_1",
  contextId: "ctx_1",
  state: "completed" as const,
  messageHistory: [],
  artifacts: [{ artifactId: "art", parts: [{ kind: "text", text: "hi" }] }],
  statusMessage: null,
  errorMessage: null,
  updatedAt: new Date(),
};

const sendParams = {
  message: {
    role: "user",
    parts: [{ kind: "text", text: "hello" }],
    messageId: "m1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.loadContextHistory.mockResolvedValue([]);
});

describe("a2a JSON-RPC dispatcher", () => {
  it("message/send runs a task and returns the Task result", async () => {
    h.createTask.mockResolvedValue({ ...rowCompleted, state: "submitted" });
    h.runA2ATask.mockResolvedValue(rowCompleted);
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: sendParams,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.kind).toBe("task");
    expect(body.result.status.state).toBe("completed");
    expect(h.runA2ATask).toHaveBeenCalledOnce();
  });

  it("message/stream returns an SSE stream ending with a final status-update", async () => {
    h.createTask.mockResolvedValue({ ...rowCompleted, state: "submitted" });
    h.runA2ATask.mockImplementation(
      async (args: { onEvent?: (e: unknown) => void }) => {
        args.onEvent?.({
          kind: "status-update",
          taskId: "a2a_1",
          contextId: "ctx_1",
          status: { state: "completed" },
          final: true,
        });
        return rowCompleted;
      },
    );
    const res = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "message/stream",
      params: sendParams,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"kind":"task"'); // initial task event
    expect(text).toContain('"kind":"status-update"');
    expect(text).toContain('"final":true');
  });

  it("tasks/get returns -32001 for an unknown task", async () => {
    h.loadTask.mockResolvedValue(null);
    const res = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/get",
      params: { id: "a2a_missing" },
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it("tasks/get returns the Task when found", async () => {
    h.loadTask.mockResolvedValue(rowCompleted);
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tasks/get",
      params: { id: "a2a_1" },
    });
    const body = await res.json();
    expect(body.result.id).toBe("a2a_1");
  });

  it("tasks/cancel rejects a terminal task with -32002", async () => {
    h.loadTask.mockResolvedValue(rowCompleted);
    const res = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tasks/cancel",
      params: { id: "a2a_1" },
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32002);
    expect(h.updateTask).not.toHaveBeenCalled();
  });

  it("tasks/cancel cancels an active task", async () => {
    h.loadTask.mockResolvedValue({ ...rowCompleted, state: "working" });
    h.updateTask.mockResolvedValue({ ...rowCompleted, state: "canceled" });
    const res = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tasks/cancel",
      params: { id: "a2a_1" },
    });
    const body = await res.json();
    expect(body.result.status.state).toBe("canceled");
  });

  it("returns -32601 for an unknown method", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 6, method: "does/not/exist" });
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });

  it("returns -32003 for push-notification config methods", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 8,
      method: "tasks/pushNotificationConfig/set",
      params: {},
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32003);
  });

  it("returns -32602 for invalid message/send params", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 9,
      method: "message/send",
      params: { message: { role: "user", parts: [] } },
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
  });

  it("rejects a JSON-RPC batch with -32600", async () => {
    const res = await rpc([{ jsonrpc: "2.0", id: 1, method: "tasks/get" }]);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
  });

  it("returns -32700 for a non-JSON body", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it("fails closed (400) when the request carries no org/workspace scope", async () => {
    // No scope-stamping middleware — mirrors an API key that never bound scope.
    const bare = new Hono();
    bare.route("/", a2aRpcRoute);
    const res = await bare.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: sendParams,
      }),
    });
    expect(res.status).toBe(400);
    expect(h.runA2ATask).not.toHaveBeenCalled();
  });

  it("agent/getAuthenticatedExtendedCard returns the card via invoke", async () => {
    h.invoke.mockResolvedValue({ protocolVersion: "1.0", name: "X" });
    const res = await rpc({
      jsonrpc: "2.0",
      id: 10,
      method: "agent/getAuthenticatedExtendedCard",
    });
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("1.0");
    expect(h.invoke).toHaveBeenCalledOnce();
  });
});
