/**
 * Unit tests for POST /:org_slug/:workspace_slug/chat/stream
 *
 * Covers: auth guard, body validation, SSE event emission, MCP server
 * allowlist wiring, conversation history loading, and message persistence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),

  streamAgentReply: vi.fn(),
  selectModel: vi.fn(),
  supportsReasoning: vi.fn(),
  modelIdOf: vi.fn(),
  loadEffectiveModelDefaults: vi.fn(),
  resolvePrompt: vi.fn(),
  chatSystemPrompt: vi.fn(),
  loadWorkspacePromptConfig: vi.fn(),

  materializeTools: vi.fn(),
  readWorkspaceContext: vi.fn(),
  injectContext: vi.fn(),

  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),

  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/ai", () => ({
  streamAgentReply: mocks.streamAgentReply,
  selectModel: mocks.selectModel,
  supportsReasoning: mocks.supportsReasoning,
  modelIdOf: mocks.modelIdOf,
  loadEffectiveModelDefaults: mocks.loadEffectiveModelDefaults,
  resolvePrompt: mocks.resolvePrompt,
  chatSystemPrompt: mocks.chatSystemPrompt,
  loadWorkspacePromptConfig: mocks.loadWorkspacePromptConfig,
}));

vi.mock("@oxagen/agent", () => ({
  materializeTools: mocks.materializeTools,
  readWorkspaceContext: mocks.readWorkspaceContext,
  injectContext: mocks.injectContext,
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  schema: {
    messages: {
      conversationId: "conversation_id",
      orgId: "org_id",
      workspaceId: "workspace_id",
      role: "role",
      content: "content",
      createdAt: "created_at",
    },
    conversations: { id: "id" },
  },
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    and: vi.fn((...args) => ({ and: args })),
    desc: vi.fn((col: unknown) => ({ desc: col })),
    eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  };
});

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE = "/v1/test-org/test-ws";
const PATH = "/chat/stream";

function post(body: unknown, extraHeaders?: Record<string, string>): Request {
  return makeRequest(`${BASE}${PATH}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/** Build an AsyncGenerator that yields a single text-delta then finish. */
async function* textStream(text: string) {
  yield { type: "text-delta", text };
  yield {
    type: "finish",
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

/** Parse all `data:` lines from a text/event-stream body into objects. */
async function readSseEvents(res: Response): Promise<unknown[]> {
  const text = await res.text();
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice("data:".length).trim();
    if (raw === "[DONE]") break;
    try {
      events.push(JSON.parse(raw));
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.selectModel.mockReturnValue("balanced-model");
  mocks.modelIdOf.mockReturnValue("anthropic/claude-sonnet");
  mocks.supportsReasoning.mockReturnValue(false);
  mocks.loadEffectiveModelDefaults.mockRejectedValue(new Error("not configured"));
  mocks.chatSystemPrompt.mockReturnValue("You are a helpful assistant.");
  mocks.resolvePrompt.mockReturnValue("You are a helpful assistant.");
  mocks.loadWorkspacePromptConfig.mockResolvedValue({});
  mocks.readWorkspaceContext.mockResolvedValue([]);
  mocks.injectContext.mockImplementation((msgs: unknown[]) => msgs);
  mocks.materializeTools.mockResolvedValue({ tools: {}, nameMap: {} });
  mocks.streamAgentReply.mockReturnValue({ fullStream: textStream("Hello world") });

  // runInTenantScope executes its callback directly
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );

  // withTenantDb executes its callback with a no-op tx
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
    const tx = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "msg-id-123" }]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    return fn(tx);
  });
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe("chat stream: auth guard", () => {
  it("returns 401 when no auth header", async () => {
    const req = makeRequest(`${BASE}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when API key is invalid", async () => {
    mocks.resolveApiKey.mockResolvedValue({ ok: false, kind: "invalid" });
    const res = await app.fetch(post({ content: "hi" }));
    expect(res.status).toBe(401);
  });
});

// ── Body validation ───────────────────────────────────────────────────────────

describe("chat stream: body validation", () => {
  it("returns 400 for invalid JSON", async () => {
    const req = makeRequest(`${BASE}${PATH}`, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: "not-json",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is missing", async () => {
    const res = await app.fetch(post({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is empty string", async () => {
    const res = await app.fetch(post({ content: "" }));
    expect(res.status).toBe(400);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("chat stream: happy path", () => {
  it("returns 200 text/event-stream", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("emits text event for text-delta parts", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    const events = await readSseEvents(res);
    const textEvents = events.filter((e) => (e as { type: string }).type === "text");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as { text: string }).text).toBe("Hello world");
  });

  it("emits usage event for finish part", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    const events = await readSseEvents(res);
    const usageEvent = events.find((e) => (e as { type: string }).type === "usage") as
      | { type: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
      | undefined;
    expect(usageEvent).toBeDefined();
    expect(usageEvent?.usage.totalTokens).toBe(15);
    expect(usageEvent?.usage.promptTokens).toBe(10);
    expect(usageEvent?.usage.completionTokens).toBe(5);
  });

  it("terminal event: done sentinel present", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(text).toContain("[DONE]");
  });

  it("calls streamAgentReply with resolved model and coreMessages", async () => {
    await app.fetch(post({ content: "Hi agent" }));
    expect(mocks.streamAgentReply).toHaveBeenCalledOnce();
    const args = mocks.streamAgentReply.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.model).toBe("balanced-model");
    const messages = args.messages as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toBe("Hi agent");
  });
});

// ── MCP server allowlist ──────────────────────────────────────────────────────

describe("chat stream: MCP server allowlist", () => {
  it("passes undefined serverAllowlist when activeServerIds is empty", async () => {
    await app.fetch(post({ content: "Hi", activeServerIds: [] }));
    expect(mocks.materializeTools).toHaveBeenCalledOnce();
    const opts = mocks.materializeTools.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.serverAllowlist).toBeUndefined();
  });

  it("passes Set serverAllowlist when activeServerIds is non-empty", async () => {
    await app.fetch(
      post({ content: "Hi", activeServerIds: ["srv_abc", "srv_xyz"] }),
    );
    expect(mocks.materializeTools).toHaveBeenCalledOnce();
    const opts = mocks.materializeTools.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.serverAllowlist).toBeInstanceOf(Set);
    const set = opts.serverAllowlist as Set<string>;
    expect(set.has("srv_abc")).toBe(true);
    expect(set.has("srv_xyz")).toBe(true);
  });

  it("loads all workspace MCPs when activeServerIds is omitted from body", async () => {
    await app.fetch(post({ content: "Hi" }));
    const opts = mocks.materializeTools.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.serverAllowlist).toBeUndefined();
  });
});

// ── Conversation history ──────────────────────────────────────────────────────

describe("chat stream: conversation history", () => {
  it("loads history when conversationId is provided", async () => {
    const historyRows = [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
    ];
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(historyRows),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "msg-id-123" }]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };
      return fn(tx);
    });

    await app.fetch(
      post({ content: "New question", conversationId: "conv-123" }),
    );

    // injectContext should receive the history + current message
    const injectedMessages = mocks.injectContext.mock.calls[0]?.[0] as Array<{
      role: string;
      content: string;
    }>;
    const userMessages = injectedMessages.filter((m) => m.role === "user");
    // Both previous + current user messages should be present
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(userMessages.at(-1)?.content).toBe("New question");
  });

  it("skips history loading when conversationId is null", async () => {
    await app.fetch(post({ content: "Stateless query" }));
    // withTenantDb is still called for materializeTools, but the select
    // for history messages should only run when conversationId is set.
    // Verify that messages are injected without history rows.
    const injectedMessages = mocks.injectContext.mock.calls[0]?.[0] as Array<{
      role: string;
      content: string;
    }>;
    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0]?.role).toBe("user");
    expect(injectedMessages[0]?.content).toBe("Stateless query");
  });
});

// ── Tool-call events ──────────────────────────────────────────────────────────

describe("chat stream: tool-call events", () => {
  async function* toolStream() {
    yield {
      type: "tool-call",
      toolCallId: "tc-1",
      toolName: "agent_code_execute",
      input: { code: "console.log('hi')", language: "node" },
    };
    yield {
      type: "tool-result",
      toolCallId: "tc-1",
      toolName: "agent_code_execute",
      output: { stdout: "hi\n", exitCode: 0 },
    };
    yield { type: "text-delta", text: "Done." };
    yield { type: "finish", totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } };
  }

  beforeEach(() => {
    mocks.materializeTools.mockResolvedValue({
      tools: {},
      nameMap: { agent_code_execute: "agent.code.execute" },
    });
    mocks.streamAgentReply.mockReturnValue({ fullStream: toolStream() });
  });

  it("emits tool-call-start with real capability name", async () => {
    const res = await app.fetch(post({ content: "run code" }));
    const events = await readSseEvents(res);
    const start = events.find(
      (e) => (e as { type: string }).type === "tool-call-start",
    ) as { type: string; capability: string; toolCallId: string } | undefined;
    expect(start).toBeDefined();
    expect(start?.capability).toBe("agent.code.execute");
    expect(start?.toolCallId).toBe("tc-1");
  });

  it("emits tool-call-end with completed status", async () => {
    const res = await app.fetch(post({ content: "run code" }));
    const events = await readSseEvents(res);
    const end = events.find(
      (e) => (e as { type: string }).type === "tool-call-end",
    ) as { type: string; status: string; toolCallId: string } | undefined;
    expect(end).toBeDefined();
    expect(end?.status).toBe("completed");
    expect(end?.toolCallId).toBe("tc-1");
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("chat stream: error handling", () => {
  it("emits error event when stream throws", async () => {
    async function* errorStream() {
      throw new Error("LLM provider error");
      // eslint-disable-next-line no-unreachable
      yield { type: "text-delta", text: "unreachable" };
    }
    mocks.streamAgentReply.mockReturnValue({ fullStream: errorStream() });

    const res = await app.fetch(post({ content: "cause error" }));
    expect(res.status).toBe(200); // SSE always 200
    const events = await readSseEvents(res);
    const errorEvent = events.find(
      (e) => (e as { type: string }).type === "error",
    ) as { type: string; message: string } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain("LLM provider error");
  });

  it("surfaces provider error parts from the stream", async () => {
    async function* providerErrorStream() {
      yield { type: "error", error: new Error("rate limited") };
      yield { type: "finish", totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }
    mocks.streamAgentReply.mockReturnValue({ fullStream: providerErrorStream() });

    const res = await app.fetch(post({ content: "check errors" }));
    const events = await readSseEvents(res);
    const textEvent = events.find(
      (e) =>
        (e as { type: string }).type === "text" &&
        ((e as { text: string }).text ?? "").includes("rate limited"),
    );
    expect(textEvent).toBeDefined();
  });
});
