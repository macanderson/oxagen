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

  invoke: vi.fn(),

  streamAgentReply: vi.fn(),
  selectModel: vi.fn(),
  supportsReasoning: vi.fn(),
  modelIdOf: vi.fn(),
  loadEffectiveModelDefaults: vi.fn(),
  resolvePrompt: vi.fn(),
  chatSystemPrompt: vi.fn(),
  loadWorkspacePromptConfigSafe: vi.fn(),

  materializeTools: vi.fn(),

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
  loadWorkspacePromptConfigSafe: mocks.loadWorkspacePromptConfigSafe,
}));

vi.mock("@oxagen/agent", () => ({
  materializeTools: mocks.materializeTools,
}));

// Spread the real module so new module-level `schema.<table>` projections in
// transitively imported services never crash this suite at import time; only
// the DB entrypoint is overridden.
vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.withTenantDb,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

// The stream's SOC 2 execution-recording block calls invoke("chat.message.execution").
vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke };
});

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
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
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

/**
 * Wrap a `fullStream` generator in the full StreamTextResult shape the unified
 * agent engine (runCodingAgent, PR #644) now awaits. The engine reads `usage`,
 * `finishReason`, `response`, and `steps` as top-level promises on the stream
 * result — the pre-unification transport instead carried usage inside the
 * stream's `finish` part. A mock returning only `{ fullStream }` makes the
 * engine throw when it awaits the missing `usage`, aborting the turn before the
 * route can emit the usage event, persist the messages, or record the SOC 2
 * execution — which is exactly what these tests exercise.
 */
function streamResult(
  fullStream: AsyncGenerator<unknown>,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } = {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  },
) {
  return {
    fullStream,
    steps: Promise.resolve([{}]),
    usage: Promise.resolve(usage),
    response: Promise.resolve({ messages: [] }),
    finishReason: Promise.resolve("stop"),
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
  // The real invoke() is async — a bare vi.fn() returning undefined would make
  // call sites that chain on its result throw synchronously instead of
  // exercising their fail-open paths.
  mocks.invoke.mockResolvedValue(undefined);
  mocks.selectModel.mockReturnValue("balanced-model");
  mocks.modelIdOf.mockReturnValue("anthropic/claude-sonnet");
  mocks.supportsReasoning.mockReturnValue(false);
  mocks.loadEffectiveModelDefaults.mockRejectedValue(
    new Error("not configured"),
  );
  mocks.chatSystemPrompt.mockReturnValue("You are a helpful assistant.");
  mocks.resolvePrompt.mockReturnValue("You are a helpful assistant.");
  mocks.loadWorkspacePromptConfigSafe.mockResolvedValue({});
  mocks.materializeTools.mockResolvedValue({ tools: {}, nameMap: {} });
  mocks.streamAgentReply.mockReturnValue(streamResult(textStream("Hello world")));

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
    const textEvents = events.filter(
      (e) => (e as { type: string }).type === "text",
    );
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as { text: string }).text).toBe("Hello world");
  });

  it("emits usage event for finish part", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    const events = await readSseEvents(res);
    const usageEvent = events.find(
      (e) => (e as { type: string }).type === "usage",
    ) as
      | {
          type: string;
          usage: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          };
        }
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
    const args = mocks.streamAgentReply.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
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
    const opts = mocks.materializeTools.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(opts.serverAllowlist).toBeUndefined();
  });

  it("passes Set serverAllowlist when activeServerIds is non-empty", async () => {
    await app.fetch(
      post({ content: "Hi", activeServerIds: ["srv_abc", "srv_xyz"] }),
    );
    expect(mocks.materializeTools).toHaveBeenCalledOnce();
    const opts = mocks.materializeTools.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(opts.serverAllowlist).toBeInstanceOf(Set);
    const set = opts.serverAllowlist as Set<string>;
    expect(set.has("srv_abc")).toBe(true);
    expect(set.has("srv_xyz")).toBe(true);
  });

  it("loads all workspace MCPs when activeServerIds is omitted from body", async () => {
    await app.fetch(post({ content: "Hi" }));
    const opts = mocks.materializeTools.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
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

    // streamAgentReply should receive the history + current message
    const streamCall = mocks.streamAgentReply.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessages = streamCall.messages.filter((m) => m.role === "user");
    // Both previous + current user messages should be present
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(userMessages.at(-1)?.content).toBe("New question");
  });

  it("skips history loading when conversationId is null", async () => {
    await app.fetch(post({ content: "Stateless query" }));
    // Verify that messages are passed without history rows.
    const streamCall = mocks.streamAgentReply.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(streamCall.messages).toHaveLength(1);
    expect(streamCall.messages[0]?.role).toBe("user");
    expect(streamCall.messages[0]?.content).toBe("Stateless query");
  });
});

// ── SOC 2 execution recording ─────────────────────────────────────────────────

describe("chat stream: execution recording (SOC 2 audit trail)", () => {
  // Make the agent lookup, history load, and message persist all resolve so the
  // qaAgent && conversationId && assistantMsgId guard is satisfied. One combined
  // row serves both the agent lookup (id/activeVersionId) and history (role/content).
  function setupAuditPath() {
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: "agt-1",
            activeVersionId: "agv-1",
            role: "user",
            content: "prior",
          },
        ]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "asmsg-1" }]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };
      return fn(tx);
    });
  }

  it("records chat.message.execution when agent, conversation, and persisted message all resolve", async () => {
    setupAuditPath();
    mocks.invoke.mockResolvedValue({ ok: true });

    const res = await app.fetch(
      post({ content: "Audit me", conversationId: "conv-123" }),
    );
    expect(res.status).toBe(200);
    await res.text(); // drain so the stream's start() callback (which fires the audit) completes

    const execCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "get_message_execution",
    );
    expect(execCall).toBeDefined();
    const input = execCall?.[1] as Record<string, unknown>;
    expect(input.messageId).toBe("asmsg-1");
    expect(input.agentId).toBe("agt-1");
    expect(input.agentVersionId).toBe("agv-1");
    expect(input.originType).toBe("chat");
    expect(input.status).toBe("completed");
  });

  it("keeps the stream intact (still emits done) when execution recording throws", async () => {
    setupAuditPath();
    mocks.invoke.mockRejectedValue(new Error("clickhouse unavailable"));

    const res = await app.fetch(
      post({ content: "Audit me", conversationId: "conv-123" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_message_execution",
      expect.objectContaining({ messageId: "asmsg-1" }),
      expect.anything(),
      expect.anything(),
    );
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
    yield {
      type: "finish",
      totalUsage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    };
  }

  beforeEach(() => {
    mocks.materializeTools.mockResolvedValue({
      tools: {},
      nameMap: { agent_code_execute: "execute_code" },
    });
    mocks.streamAgentReply.mockReturnValue(
      streamResult(toolStream(), {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
      }),
    );
  });

  it("emits tool-call-start with real capability name", async () => {
    const res = await app.fetch(post({ content: "run code" }));
    const events = await readSseEvents(res);
    const start = events.find(
      (e) => (e as { type: string }).type === "tool-call-start",
    ) as { type: string; capability: string; toolCallId: string } | undefined;
    expect(start).toBeDefined();
    expect(start?.capability).toBe("execute_code");
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
    async function* errorStream(): AsyncGenerator<never> {
      throw new Error("LLM provider error");
    }
    mocks.streamAgentReply.mockReturnValue(streamResult(errorStream()));

    const res = await app.fetch(post({ content: "cause error" }));
    expect(res.status).toBe(200); // SSE always 200
    const events = await readSseEvents(res);
    const errorEvent = events.find(
      (e) => (e as { type: string }).type === "error",
    ) as { type: string; message: string } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain("LLM provider error");
  });

  it("propagates provider error parts as typed error events (not inline text)", async () => {
    // AI SDK yields model-layer failures as `error` parts, not thrown exceptions.
    // They must surface as a typed { type: "error" } SSE event so clients can
    // distinguish failure from a complete reply — never injected into the text.
    async function* providerErrorStream() {
      yield { type: "text-delta", text: "partial " };
      yield { type: "error", error: new Error("rate limited") };
      yield {
        type: "finish",
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
    mocks.streamAgentReply.mockReturnValue(
      streamResult(providerErrorStream()),
    );

    const res = await app.fetch(post({ content: "check errors" }));
    const events = await readSseEvents(res);

    const errorEvent = events.find(
      (e) => (e as { type: string }).type === "error",
    ) as { type: string; message: string } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain("rate limited");

    // The error must NOT have been injected as a text delta.
    const corruptedText = events.find(
      (e) =>
        (e as { type: string }).type === "text" &&
        ((e as { text: string }).text ?? "").includes("rate limited"),
    );
    expect(corruptedText).toBeUndefined();
  });

  it("does not persist the assistant turn when the stream errors mid-flight", async () => {
    async function* providerErrorStream() {
      yield { type: "text-delta", text: "partial answer" };
      yield { type: "error", error: new Error("context overflow") };
      yield {
        type: "finish",
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
    mocks.streamAgentReply.mockReturnValue(
      streamResult(providerErrorStream()),
    );

    const insertSpy = vi.fn().mockReturnThis();
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        insert: insertSpy,
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "msg-id-123" }]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };
      return fn(tx);
    });

    await app.fetch(post({ content: "boom", conversationId: "conv-err" }));
    // History-load select runs, but no message insert should happen on a
    // mid-stream error (partial text must not be written as a successful turn).
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("logs (does not silently swallow) a message-persistence failure", async () => {
    const { logger } = await import("../middleware/logger");
    const errorSpy = vi.mocked(logger.error);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    // History select succeeds (empty), but the persistence insert rejects.
    let callCount = 0;
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      callCount += 1;
      const isPersistenceCall = callCount >= 2;
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        insert: isPersistenceCall
          ? vi.fn(() => {
              throw new Error("RLS violation");
            })
          : vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "msg-id-123" }]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };
      return fn(tx);
    });

    const res = await app.fetch(
      post({ content: "persist me", conversationId: "conv-persist" }),
    );
    // SSE response still completes (the failure must not corrupt the stream).
    expect(res.status).toBe(200);
    // Drain so the stream's start() callback completes: under the unified engine
    // (runCodingAgent) persistence runs asynchronously inside the stream body,
    // AFTER the engine's usage/finishReason promises resolve — so the log is only
    // guaranteed to have fired once the SSE body is fully read.
    await res.text();
    // …but the failure was logged, not silently swallowed.
    const logged =
      consoleErrorSpy.mock.calls.some((c) =>
        String(c[0]).includes("persistence failed"),
      ) || errorSpy.mock.calls.length > 0;
    expect(logged).toBe(true);

    consoleErrorSpy.mockRestore();
  });
});

// ── Per-turn budget & workspace governance ────────────────────────────────────
//
// The pure precedence/merge logic (override wins; workspace ceiling clamps;
// default seeds) is unit-tested in @oxagen/billing (turn-budget-policy.test.ts,
// turn-budget.test.ts). These tests pin the ROUTE's wiring of that logic: the
// body schema accepts/rejects the budget field, the governance read goes
// through invoke() with the right capability + surface, and a failed
// governance read fails OPEN (the turn still streams).

describe("chat stream: per-turn budget & workspace governance", () => {
  it("returns 400 for a nonsense budget override (enabled with null limit)", async () => {
    const res = await app.fetch(
      post({
        content: "Hello",
        budget: { enabled: true, limitUsd: null, mode: "enforce", graceOveragePct: 0.25 },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts a valid per-turn budget override and still streams", async () => {
    const res = await app.fetch(
      post({
        content: "Hello",
        budget: { enabled: true, limitUsd: 2, mode: "enforce", graceOveragePct: 0.25 },
      }),
    );
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    expect(
      events.some((e) => (e as { type: string }).type === "text"),
    ).toBe(true);
  });

  it("reads workspace budget governance via invoke(get_budget_policy, surface: agent)", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.status).toBe(200);
    await res.text(); // drain so the stream body (where the read runs) completes
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_budget_policy",
      {},
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("fails open (turn still streams) when the governance read rejects", async () => {
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    mocks.invoke.mockImplementation(async (name: string) => {
      if (name === "get_budget_policy") throw new Error("governance down");
      return undefined;
    });

    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.status).toBe(200);
    const events = await readSseEvents(res);
    expect(
      events.some((e) => (e as { type: string }).type === "text"),
    ).toBe(true);
    // Fail-open is logged, never silent.
    expect(
      consoleWarnSpy.mock.calls.some((c) =>
        String(c[0]).includes("workspace budget governance read failed"),
      ),
    ).toBe(true);

    consoleWarnSpy.mockRestore();
  });
});
