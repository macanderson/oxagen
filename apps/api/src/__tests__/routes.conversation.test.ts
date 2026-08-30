/**
 * Unit tests for conversation route handlers:
 *   conversation.archive, conversation.delete, conversation.purge,
 *   conversation.rename, chat.message.send
 *
 * conversation.list is already covered in conversation.list.test.ts
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── conversation.archive ─────────────────────────────────────────────────

describe("conversation.archive route", () => {
  const PATH = "/conversations/archive";

  it("happy path archive: 200", async () => {
    mocks.invoke.mockResolvedValue({ updated: 2 });
    const res = await app.fetch(
      post(PATH, { conversationIds: ["c1", "c2"], archived: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
  });

  it("calls invoke with 'archive_conversation' and surface 'api'", async () => {
    await app.fetch(post(PATH, { conversationIds: ["c1"], archived: false }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("archive_conversation");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.archived).toBe(false);
  });

  it("happy path restore (archived=false): 200", async () => {
    mocks.invoke.mockResolvedValue({ updated: 1 });
    const res = await app.fetch(
      post(PATH, { conversationIds: ["c1"], archived: false }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { updated: number };
    expect(json.updated).toBe(1);
  });

  it("empty conversationIds array → 400", async () => {
    const res = await app.fetch(
      post(PATH, { conversationIds: [], archived: true }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing archived field → 400", async () => {
    const res = await app.fetch(post(PATH, { conversationIds: ["c1"] }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── conversation.delete ───────────────────────────────────────────────────

describe("conversation.delete route", () => {
  const PATH = "/conversations/delete";

  it("happy path: 200 with deleted count", async () => {
    mocks.invoke.mockResolvedValue({ deleted: 3 });
    const res = await app.fetch(
      post(PATH, { conversationIds: ["c1", "c2", "c3"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3 });
  });

  it("calls invoke with 'delete_conversation'", async () => {
    await app.fetch(post(PATH, { conversationIds: ["c1"] }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_conversation");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).toEqual({ conversationIds: ["c1"] });
  });

  it("empty conversationIds → 400", async () => {
    const res = await app.fetch(post(PATH, { conversationIds: [] }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── conversation.purge ────────────────────────────────────────────────────

describe("conversation.purge route", () => {
  const PATH = "/conversations/purge";

  it("happy path with JSON body: 200", async () => {
    mocks.invoke.mockResolvedValue({ deleted: 10 });
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 10 });
  });

  it("calls invoke with 'purge_conversations'", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("purge_conversations");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("empty body (no JSON) → falls back to {} default → 200", async () => {
    // conversation.purge uses c.req.json().catch(()=>({})) so empty body is OK
    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "POST",
        headers: authHeaders(),
        body: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("purge_conversations");
  });

  it("invoke throws → 500", async () => {
    mocks.invoke.mockRejectedValue(new Error("purge failed"));
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(500);
  });
});

// ── conversation.rename ───────────────────────────────────────────────────

describe("conversation.rename route", () => {
  const PATH = "/conversations/rename";

  it("happy path PATCH: 200", async () => {
    const invokeResult = { publicId: "conv-1", title: "New Title" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-1", title: "New Title" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'rename_conversation'", async () => {
    await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-2", title: "Renamed" }),
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("rename_conversation");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.conversationId).toBe("conv-2");
    expect(body.title).toBe("Renamed");
  });

  it("empty title → 400", async () => {
    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-1", title: "" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── chat.message.send ─────────────────────────────────────────────────────

describe("chat.message.send route", () => {
  const PATH = "/chat/messages";
  const VALID_BODY = {
    conversationId: null,
    parentMessageId: null,
    branchReason: null,
    content: "Hello, world!",
    contentBlocks: [],
  };

  it("happy path: returns 202", async () => {
    const invokeResult = {
      conversationId: "conv-1",
      userMessageId: "msg-u-1",
      assistantMessageId: "msg-a-1",
      activeLeafMessageId: "msg-a-1",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'send_message'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("send_message");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.content).toBe("Hello, world!");
  });

  it("empty content → 400", async () => {
    const res = await app.fetch(post(PATH, { ...VALID_BODY, content: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid branchReason enum → 400", async () => {
    const res = await app.fetch(
      post(PATH, { ...VALID_BODY, branchReason: "invalid" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
