/**
 * chat.stream.test.ts
 *
 * The REST chat surface is the streaming adapter of `ask_assistant`: it
 * publishes the ingress, invokes the contract through the kernel with the
 * stream beside the invoke (`streamAssistantTurn`, @oxagen/agent), answers a
 * refusal before the turn is prepared through the error middleware, and
 * translates the turn's parts and output into this surface's SSE wire format.
 * The kernel is a fake here; the handler's own tests are
 * packages/agent/src/handlers/assistant.ask.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hono as HonoType } from "hono";

interface Stream {
  overrides: Record<string, unknown>;
  hooks: {
    onTools?: (m: Record<string, string>) => void;
    onRun?: (r: { runId: string }) => void;
    onPart?: (p: unknown) => void;
    onApprovalRequired?: (e: unknown) => void;
    onBudgetNotice?: (n: unknown) => void;
    onUsage?: (u: unknown) => void;
    abortSignal?: AbortSignal;
  };
  onPrepared: () => void;
}

const mocks = vi.hoisted(() => ({
  capabilityContext: vi.fn(),
  invoke: vi.fn(),
  stream: null as Stream | null,
}));

vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));
vi.mock("../../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/agent", () => ({
  streamAssistantTurn: (stream: Stream, invokeTurn: () => Promise<unknown>) => {
    mocks.stream = stream;
    return invokeTurn();
  },
}));
vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke };
});

const { Hono } = await import("hono");
const { HandlerError } = await import("@oxagen/oxagen");
const { CapabilityError } = await import("@oxagen/oxagen/kernel");
const { errorMiddleware } = await import("../../middleware/error");
const { CHAT_STREAM_HEARTBEAT_MS, chatStreamRoute } = await import(
  "./chat.stream"
);
const { assistantAskRoute } = await import("./assistant.ask");

const app = new Hono();
app.onError(errorMiddleware as never);
app.route(
  "/v1/:org_slug/:workspace_slug/chat/stream",
  chatStreamRoute as unknown as HonoType,
);
app.route(
  "/v1/:org_slug/:workspace_slug/assistant/ask",
  assistantAskRoute as unknown as HonoType,
);

const CTX = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  userId: "33333333-3333-3333-3333-333333333333",
  apiKeyId: null,
  requestId: "44444444-4444-4444-4444-444444444444",
  surface: "api" as const,
  messageId: null,
  clientIp: null,
};

const OUTPUT = {
  conversationId: "55555555-5555-4555-8555-555555555555",
  userMessageId: "66666666-6666-4666-8666-666666666666",
  assistantMessageId: "77777777-7777-4777-8777-777777777777",
  runId: "arun_0123456789abcdef012345",
  reply: "hello world",
  parkedCards: [],
};

async function post(
  body: unknown | string,
  route: "chat/stream" | "assistant/ask" = "chat/stream",
): Promise<Response> {
  mocks.stream = null;
  return app.fetch(
    new Request(`http://localhost/v1/acme/main/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** The `data:` payloads in order, the terminal `done` event last. */
async function readSse(
  res: Response,
): Promise<{ events: Array<Record<string, unknown>>; done: unknown }> {
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  let done: unknown = undefined;
  for (const block of text.split("\n\n")) {
    if (block.startsWith("event: done")) {
      const data = block.split("\n")[1]!.slice("data: ".length);
      done = data === "[DONE]" ? "[DONE]" : JSON.parse(data);
    } else if (block.startsWith("data: ")) {
      events.push(JSON.parse(block.slice("data: ".length)));
    }
  }
  return { events, done };
}

/** A fake kernel invoke: the turn prepared, then its hooks, then the output. */
async function fakeTurn(): Promise<unknown> {
  const stream = mocks.stream;
  stream?.onPrepared();
  stream?.hooks.onTools?.({ graph_query: "query_ontology" });
  stream?.hooks.onRun?.({ runId: OUTPUT.runId });
  stream?.hooks.onPart?.({ type: "start-step" });
  stream?.hooks.onPart?.({
    type: "tool-call",
    toolCallId: "c1",
    toolName: "graph_query",
    input: { q: "x" },
  });
  stream?.hooks.onPart?.({ type: "text-delta", text: "hello world" });
  stream?.hooks.onUsage?.({
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    cachedInputTokens: 0,
  });
  return OUTPUT;
}

/** A turn that fails after it was prepared: the stream is open. */
function failAfterPrepared(err: unknown): () => Promise<unknown> {
  return async () => {
    mocks.stream?.onPrepared();
    throw err;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(CTX);
  mocks.invoke.mockImplementation(fakeTurn);
});

describe("POST chat/stream — ingress", () => {
  it("rejects a malformed JSON body with 400", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects an empty message, an oversized one and a non-uuid conversation with 400 (negative)", async () => {
    expect((await post({ content: "" })).status).toBe(400);
    expect((await post({ content: "x".repeat(32_769) })).status).toBe(400);
    expect(
      (await post({ content: "hi", conversationId: "conv_1" })).status,
    ).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("ask_assistant — the same gates on both adapters", () => {
  it.each([
    [
      "a role the contract does not grant",
      () =>
        new HandlerError({ code: "forbidden", reason: "org_role_required" }),
      403,
    ],
    [
      "an IAM denial",
      () => new CapabilityError("ask_assistant", "authz_denied", "denied"),
      403,
    ],
    [
      "the assistant spend cap",
      () =>
        Object.assign(new Error("the assistant spend cap is reached"), {
          code: "assistant_spend_cap",
        }),
      402,
    ],
    [
      "a caller with no person to ask as",
      () => new HandlerError({ code: "forbidden", reason: "no_principal" }),
      403,
    ],
  ])(
    "refuses %s before the stream opens, with the status and envelope POST /assistant/ask answers",
    async (_why, refusal, status) => {
      mocks.invoke.mockImplementation(async () => {
        throw refusal();
      });
      const stream = await post({ content: "hi" });
      const ask = await post({ content: "hi" }, "assistant/ask");
      expect(stream.status).toBe(status);
      expect(ask.status).toBe(status);
      expect(stream.headers.get("content-type")).toContain("application/json");
      expect(await stream.json()).toEqual(await ask.json());
      expect(mocks.invoke.mock.calls.map((c) => c[0])).toEqual([
        "ask_assistant",
        "ask_assistant",
      ]);
    },
  );

  it.each([
    ["engine_unavailable", 503],
    ["assistant_run_not_recorded", 503],
    ["engine_aborted", 409],
    ["model_call_failed", 502],
    ["assistant_model_key_limit", 402],
  ] as const)(
    "POST /assistant/ask answers the turn failure %s with %i and its code, never a 500",
    async (code, status) => {
      mocks.invoke.mockRejectedValueOnce(
        Object.assign(new Error(`turn failed: ${code}`), { code }),
      );
      const res = await post({ content: "hi" }, "assistant/ask");
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({
        error: { code, message: `turn failed: ${code}` },
      });
    },
  );
});

describe("POST chat/stream — the turn on the wire", () => {
  it("invokes ask_assistant through the kernel with the contract's input, and carries the overrides beside it", async () => {
    await post({
      content: "hi",
      pageContext: { route: "fleet", orgSlug: "acme", workspaceSlug: "main" },
      tier: "fast",
    }).then((r) => r.text());
    expect(mocks.invoke).toHaveBeenCalledWith(
      "ask_assistant",
      {
        conversationId: null,
        content: "hi",
        pageContext: {
          route: "fleet",
          orgSlug: "acme",
          workspaceSlug: "main",
          entityId: null,
          entityLabel: null,
        },
      },
      CTX,
      { surface: "api" },
    );
    expect(mocks.stream!.overrides).toEqual({
      activeServerIds: [],
      tier: "fast",
      model: null,
      effort: null,
      budget: null,
    });
  });

  // The flyout sends the name its page gave the record beside the record's
  // id. The body's page context is the contract's own schema, so the label
  // reaches ask_assistant as the person saw it.
  it("carries the record's label beside its id to ask_assistant", async () => {
    await post({
      content: "why did this fail?",
      pageContext: {
        route: "runs",
        orgSlug: "acme",
        workspaceSlug: "main",
        entityId: "arun_01k9",
        entityLabel: "Fix the flaky checkout test",
      },
    }).then((r) => r.text());
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({
      pageContext: {
        entityId: "arun_01k9",
        entityLabel: "Fix the flaky checkout test",
      },
    });
  });

  it("refuses a label past the contract's cap with 400 before the turn starts (negative)", async () => {
    const res = await post({
      content: "why did this fail?",
      pageContext: {
        route: "runs",
        orgSlug: "acme",
        workspaceSlug: "main",
        entityId: "arun_01k9",
        entityLabel: "x".repeat(257),
      },
    });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  // The route builds ask_assistant's input field by field, so a field the
  // contract gains is dropped here unless the route names it.
  it("carries a goal to ask_assistant, and sends none for an ordinary turn", async () => {
    await post({
      content: "author the rule",
      goal: { statement: "the rule links both sources" },
    }).then((r) => r.text());
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "ask_assistant",
      expect.objectContaining({
        goal: { statement: "the rule links both sources", maxRounds: 3 },
      }),
      CTX,
      { surface: "api" },
    );

    await post({ content: "hi" }).then((r) => r.text());
    expect(mocks.invoke.mock.lastCall?.[1]).not.toHaveProperty("goal");
  });

  it("streams the run, the translated parts, one usage event, then the output as the terminal", async () => {
    const res = await post({ content: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const { events, done } = await readSse(res);
    expect(events.map((e) => e.type)).toEqual([
      "run",
      "step-start",
      "tool-call-start",
      "text",
      "usage",
    ]);
    expect(events[0]).toEqual({ type: "run", runId: OUTPUT.runId });
    // The translator names the call by the capability the turn mapped it to.
    expect(events[2]).toMatchObject({ capability: "query_ontology" });
    expect(events.at(-1)).toEqual({
      type: "usage",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
    expect(done).toEqual(OUTPUT);
  });

  it("forwards approval and budget notices as their SSE events", async () => {
    const parked = {
      approvalId: "apr_1",
      capability: "set_budget",
      expiresAt: "2026-09-14T10:05:00.000Z",
    };
    mocks.invoke.mockImplementationOnce(async () => {
      mocks.stream!.onPrepared();
      mocks.stream!.hooks.onApprovalRequired?.({
        ...parked,
        inputPreview: { usd: 5 },
        riskLevel: "high",
      });
      mocks.stream!.hooks.onBudgetNotice?.({
        state: "within_grace",
        costUsd: 1.2,
        limitUsd: 1,
        mode: "grace",
      });
      return { ...OUTPUT, parkedCards: [parked] };
    });
    const { events, done } = await readSse(await post({ content: "hi" }));
    expect(events[0]).toMatchObject({
      type: "approval-required",
      approvalId: "apr_1",
      capability: "set_budget",
    });
    expect(events[1]).toEqual({
      type: "budget-notice",
      state: "within_grace",
      costUsd: 1.2,
      limitUsd: 1,
      mode: "grace",
    });
    expect((done as { parkedCards: unknown }).parkedCards).toEqual([parked]);
  });

  it.each([
    [
      "the engine unavailable",
      Object.assign(new Error("the assistant engine is unavailable"), {
        code: "engine_unavailable",
      }),
      "engine_unavailable",
    ],
    [
      "an unrecorded run",
      Object.assign(new Error("could not be recorded"), {
        code: "assistant_run_not_recorded",
      }),
      "assistant_run_not_recorded",
    ],
    [
      "a model call the provider refused",
      Object.assign(new Error("the model provider answered 401"), {
        code: "model_call_failed",
      }),
      "model_call_failed",
    ],
    [
      "the minted key's spend ceiling",
      Object.assign(new Error("Model spend refused"), {
        code: "assistant_model_key_limit",
      }),
      "assistant_model_key_limit",
    ],
    [
      "an unknown conversation",
      new HandlerError({ code: "not_found", reason: "conversation_not_found" }),
      "conversation_not_found",
    ],
    [
      "an error with no stable code",
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      undefined,
    ],
  ])(
    "surfaces %s after the stream opened as a typed error, and still terminates (negative)",
    async (_why, err, code) => {
      mocks.invoke.mockImplementationOnce(failAfterPrepared(err));
      const { events, done } = await readSse(await post({ content: "hi" }));
      expect(events).toEqual([
        { type: "error", message: (err as Error).message, code },
      ]);
      expect(done).toBe("[DONE]");
    },
  );
});

describe("POST chat/stream — a client that goes away (ADR-092)", () => {
  /** A turn that is prepared, names its run, and ends when the test says. */
  function heldTurn(): { finish: (output: unknown) => void; ended: boolean } {
    const held: { finish: (output: unknown) => void; ended: boolean } = {
      finish: () => undefined,
      ended: false,
    };
    mocks.invoke.mockImplementationOnce(async () => {
      mocks.stream!.onPrepared();
      mocks.stream!.hooks.onRun?.({ runId: OUTPUT.runId });
      const output = await new Promise((resolve) => {
        held.finish = resolve;
      });
      held.ended = true;
      return output;
    });
    return held;
  }

  it("hands the turn no abort signal, so a dropped connection does not stop it", async () => {
    const turn = heldTurn();
    const client = new AbortController();
    const res = await app.fetch(
      new Request("http://localhost/v1/acme/main/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
        signal: client.signal,
      }),
    );
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(OUTPUT.runId);
    // The person's connection drops mid-turn.
    client.abort();
    await reader.cancel();
    expect(mocks.stream!.hooks.abortSignal).toBeUndefined();
    // The turn runs on and ends on its own clock. The writes after the drop
    // are dropped quietly rather than failing it.
    turn.finish(OUTPUT);
    await vi.waitFor(() => {
      expect(turn.ended).toBe(true);
    });
  });

  it("writes a keep-alive comment while the turn is quiet, and none after the terminal", async () => {
    vi.useFakeTimers();
    try {
      const turn = heldTurn();
      const res = await post({ content: "hi" });
      await vi.advanceTimersByTimeAsync(CHAT_STREAM_HEARTBEAT_MS * 2);
      turn.finish(OUTPUT);
      await vi.advanceTimersByTimeAsync(CHAT_STREAM_HEARTBEAT_MS * 2);
      const text = await res.text();
      expect(text.match(/^: keep-alive$/gm)).toHaveLength(2);
      expect(
        text.endsWith(`event: done\ndata: ${JSON.stringify(OUTPUT)}\n\n`),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the comment out of the events a reader parses (negative)", async () => {
    vi.useFakeTimers();
    try {
      const turn = heldTurn();
      const res = await post({ content: "hi" });
      await vi.advanceTimersByTimeAsync(CHAT_STREAM_HEARTBEAT_MS);
      turn.finish(OUTPUT);
      await vi.advanceTimersByTimeAsync(0);
      const { events, done } = await readSse(res);
      expect(events).toEqual([{ type: "run", runId: OUTPUT.runId }]);
      expect(done).toEqual(OUTPUT);
    } finally {
      vi.useRealTimers();
    }
  });
});
