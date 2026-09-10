/**
 * The loop against the fake engine: a full turn with concurrent answers, the
 * failure reporting, cancellation, and the resume paths (a dropped stream,
 * a truncated replay, a stream lost for good).
 */
import { describe, expect, it, vi } from "vitest";
import { StellaEngineClient } from "./client";
import {
  DEFAULT_RESUME_POLICY,
  TurnStreamLostError,
  classifyProviderError,
  classifyToolError,
  driveTurn,
  resumeAfter,
  type DriveTurnHandlers,
} from "./drive-turn";
import {
  FakeEngine,
  goldenDelta,
  goldenProviderAnswer,
  goldenScript,
  goldenToolAnswer,
  type FakeEngineOptions,
} from "./fake-engine";
import type { AgentEvent, ServerFrame } from "./wire";

function setup(
  options: FakeEngineOptions = {},
  script: ServerFrame[] = goldenScript(),
) {
  const engine = new FakeEngine(options);
  engine.scriptTurn(script);
  const client = new StellaEngineClient({
    baseUrl: "http://engine.test",
    token: "fake-token",
    fetchImpl: engine.fetch,
  });
  return { engine, client };
}

const noSleep = async (): Promise<void> => undefined;

function goldenHandlers(
  overrides: Partial<DriveTurnHandlers> = {},
): DriveTurnHandlers {
  return {
    onProviderRequest: async (req, ctx) => {
      if (req.request_id === "prov-1-1") await ctx.deltas(goldenDelta);
      return goldenProviderAnswer(req.request_id);
    },
    onToolRequest: async () => goldenToolAnswer,
    ...overrides,
  };
}

describe("driveTurn", () => {
  it("runs the golden turn to completion, answering both ports and forwarding events with seq", async () => {
    const { engine, client } = setup();
    const events: Array<[string, number]> = [];
    const result = await driveTurn(client, {
      request: {
        provider_id: "openrouter",
        messages: [{ role: "user", content: "list the nodes" }],
      },
      handlers: goldenHandlers({
        onEvent: (event: AgentEvent, seq) => events.push([event.type, seq]),
      }),
      sleep: noSleep,
    });
    expect(result.outcome).toEqual({
      status: "completed",
      text: "There are 3 nodes.",
      cost_usd: 0.002,
    });
    expect(result.providerCalls).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.lastSeq).toBe(10);
    expect(result.resumes).toBe(0);
    expect(events).toEqual([
      ["stage", 2],
      ["tool_start", 4],
      ["tool_result", 6],
      ["text_delta", 7],
      ["text", 8],
      ["turn_complete", 9],
    ]);
    expect(engine.posts.map((p) => `${p.route}:${p.status}`)).toEqual([
      "provider-result:200",
      "tool-result:200",
      "provider-delta:200",
      "provider-result:200",
    ]);
    expect(engine.turnRequests[0]).toMatchObject({ provider_id: "openrouter" });
  });

  it("drives a session turn and reports the session id", async () => {
    const { client } = setup();
    const { session_id } = await client.createSession({ system_prompt: "s" });
    const result = await driveTurn(client, {
      sessionId: session_id,
      request: {
        provider_id: "openrouter",
        input: [{ role: "user", content: "hi" }],
      },
      handlers: goldenHandlers(),
      sleep: noSleep,
    });
    expect(result.sessionId).toBe(session_id);
    expect(result.outcome.status).toBe("completed");
    const view = await client.getSession(session_id);
    expect(view.turns_completed).toBe(1);
    expect(view.live_turn).toBeNull();
  });

  it("reports a rejected provider handler to the engine as a classified error", async () => {
    const { engine, client } = setup();
    const result = await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onProviderRequest: async (req) => {
          if (req.request_id === "prov-1-0") throw new Error("socket reset");
          return goldenProviderAnswer(req.request_id);
        },
      }),
      sleep: noSleep,
    });
    // The fake keeps scripting after any answer, so the turn still ends.
    expect(result.outcome.status).toBe("completed");
    expect(engine.posts[0]!.body).toEqual({
      request_id: "prov-1-0",
      status: "error",
      error: { kind: "transport", message: "socket reset" },
    });
  });

  it("uses the host's classifier when it supplies one", async () => {
    const { engine, client } = setup();
    await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onProviderRequest: async (req) => {
          if (req.request_id === "prov-1-0") throw new Error("429");
          return goldenProviderAnswer(req.request_id);
        },
        classifyProviderError: () => ({
          kind: "rate_limited",
          message: "slow down",
          retry_after_ms: 1000,
        }),
      }),
      sleep: noSleep,
    });
    expect(engine.posts[0]!.body).toMatchObject({
      status: "error",
      error: { kind: "rate_limited" },
    });
  });

  it("turns a thrown tool into the error arm, keeping a recognised class", async () => {
    const { engine, client } = setup();
    await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onToolRequest: async () => {
          throw Object.assign(new Error("policy says no"), {
            class: "refused_by_policy",
          });
        },
      }),
      sleep: noSleep,
    });
    const tool = engine.posts.find((p) => p.route === "tool-result")!;
    expect(tool.body).toEqual({
      request_id: "tool-1-0",
      output: {
        error: { message: "policy says no", class: "refused_by_policy" },
      },
    });
  });

  it("cancels the engine turn when the caller's signal aborts and returns the aborted outcome", async () => {
    const { engine, client } = setup();
    const controller = new AbortController();
    const result = await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onProviderRequest: async (req, ctx) => {
          controller.abort();
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return goldenProviderAnswer(req.request_id);
        },
      }),
      signal: controller.signal,
      sleep: noSleep,
      cancelGraceMs: 50,
    });
    expect(result.outcome).toEqual({
      status: "aborted",
      reason: "cancelled",
      cost_usd: 0,
    });
    // The late provider answer after the cancel is a stale 404/409 and is tolerated.
    expect(
      engine.posts.every(
        (p) => p.status === 200 || p.status === 404 || p.status === 409,
      ),
    ).toBe(true);
  });

  it("resumes with ?after= when the stream drops, without re-asking for what it holds", async () => {
    const { engine, client } = setup({ dropAfterFrames: 4 });
    const resumes: Array<{ attempt: number; after: number }> = [];
    const result = await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onResume: ({ attempt, after }) => resumes.push({ attempt, after }),
      }),
      sleep: noSleep,
    });
    expect(result.outcome.status).toBe("completed");
    expect(result.resumes).toBe(1);
    expect(resumes).toEqual([{ attempt: 1, after: 4 }]);
    expect(engine.posts.filter((p) => p.status !== 200)).toEqual([]);
  });

  it("continues from the oldest retained frame after a truncated replay", async () => {
    // Four events the engine emits without waiting on the host, then the
    // outcome. The stream drops after two; the engine keeps going into a
    // ring that retains one frame, so the resume point is gone.
    const event = (n: number): ServerFrame =>
      ({
        type: "event",
        event: { type: "text_delta", delta: `d${n}` },
      }) as ServerFrame;
    const script: ServerFrame[] = [
      event(1),
      event(2),
      event(3),
      event(4),
      {
        type: "turn_complete",
        outcome: { status: "completed", text: "d", cost_usd: 0 },
      },
    ];
    const { client } = setup({ dropAfterFrames: 2, retainedFrames: 1 }, script);
    const truncated: Array<[number, number]> = [];
    const result = await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onReplayTruncated: (f) =>
          truncated.push([f.requested_after, f.oldest_retained]),
      }),
      sleep: noSleep,
    });
    expect(truncated).toEqual([[2, 5]]);
    expect(result.outcome.status).toBe("completed");
    expect(result.lastSeq).toBe(5);
  });

  it("gives up after the resume policy is spent", async () => {
    const engine = new FakeEngine();
    // A script that never completes: the fake parks after the first request
    // and the host never answers, while every stream is closed at once.
    engine.scriptTurn(goldenScript());
    let opens = 0;
    const client = new StellaEngineClient({
      baseUrl: "http://engine.test",
      token: "fake-token",
      fetchImpl: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/events")) {
          opens += 1;
          return new Response(new ReadableStream({ start: (c) => c.close() }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return engine.fetch(input, init);
      },
    });
    const err = await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers(),
      resume: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnStreamLostError);
    expect(opens).toBe(3);
  });

  it("counts a frame tag it does not know instead of failing", async () => {
    const script: ServerFrame[] = [
      { type: "future_frame", payload: 1 } as unknown as ServerFrame,
      {
        type: "turn_complete",
        outcome: { status: "completed", text: "", cost_usd: 0 },
      },
    ];
    const { client } = setup({}, script);
    const result = await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers(),
      sleep: noSleep,
    });
    expect(result.unknownFrames).toBe(1);
    expect(result.outcome.status).toBe("completed");
  });

  it("answers a requery request through the host's handler, and with null when there is none", async () => {
    const script: ServerFrame[] = [
      {
        type: "requery_request",
        request_id: "rq-1",
        signal: {
          prompt: "p",
          recent_tool_calls: [],
          touched_paths: [],
          errors_seen: [],
          step: 1,
          since_last_query: 1,
        },
      } as ServerFrame,
      {
        type: "turn_complete",
        outcome: { status: "completed", text: "", cost_usd: 0 },
      },
    ];
    const withHandler = setup({}, script);
    await driveTurn(withHandler.client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onRequeryRequest: async (signal) => `context for ${signal.prompt}`,
      }),
      sleep: noSleep,
    });
    expect(
      withHandler.engine.posts.find((p) => p.route === "requery-result")?.body,
    ).toEqual({
      request_id: "rq-1",
      context: "context for p",
    });

    const without = setup({}, script);
    await driveTurn(without.client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers(),
      sleep: noSleep,
    });
    expect(
      without.engine.posts.find((p) => p.route === "requery-result")?.body,
    ).toEqual({
      request_id: "rq-1",
      context: null,
    });

    const throwing = setup({}, script);
    const err = await driveTurn(throwing.client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({
        onRequeryRequest: async () => {
          throw new Error("context plane down");
        },
      }),
      sleep: noSleep,
    }).catch((e: unknown) => e);
    // The step still proceeded with a null answer, and the host hears about the failure.
    expect(
      throwing.engine.posts.find((p) => p.route === "requery-result")?.body,
    ).toEqual({ request_id: "rq-1", context: null });
    expect((err as Error).message).toBe("context plane down");
  });

  it("waits the real backoff between reconnects when no sleep is injected", async () => {
    const { client } = setup({ dropAfterFrames: 2 });
    const started = Date.now();
    const result = await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers(),
      resume: { baseDelayMs: 30, maxDelayMs: 30, maxAttempts: 3 },
    });
    expect(result.resumes).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("delivers hold and release frames to onHold", async () => {
    const script: ServerFrame[] = [
      { type: "turn_held", reason: "operator" },
      { type: "turn_released" },
      {
        type: "turn_complete",
        outcome: { status: "completed", text: "", cost_usd: 0 },
      },
    ];
    const { client } = setup({}, script);
    const onHold = vi.fn();
    await driveTurn(client, {
      request: { provider_id: "openrouter", messages: [] },
      handlers: goldenHandlers({ onHold }),
      sleep: noSleep,
    });
    expect(onHold.mock.calls).toEqual([
      [{ held: true, reason: "operator" }, 1],
      [{ held: false }, 2],
    ]);
  });
});

describe("helpers", () => {
  it("classifies an abort as cancelled and anything else as transport", () => {
    expect(
      classifyProviderError(
        Object.assign(new Error("x"), { name: "AbortError" }),
      ),
    ).toEqual({ kind: "cancelled" });
    expect(classifyProviderError("boom")).toEqual({
      kind: "transport",
      message: "boom",
    });
  });

  it("keeps only a recognised error class on a tool failure", () => {
    expect(
      classifyToolError(Object.assign(new Error("m"), { class: "nonsense" })),
    ).toEqual({ error: { message: "m" } });
    expect(
      classifyToolError(Object.assign(new Error("m"), { class: "timeout" })),
    ).toEqual({
      error: { message: "m", class: "timeout" },
    });
  });

  it("resumes after the last seq only when the outstanding requests are known", () => {
    expect(resumeAfter(41, true)).toBe(41);
    expect(resumeAfter(41, false)).toBe(0);
  });

  it("gives up inside the server's thirty-second parking window", () => {
    const { maxAttempts, baseDelayMs, maxDelayMs } = DEFAULT_RESUME_POLICY;
    let total = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      total += Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    }
    expect(total).toBeLessThan(30_000);
  });
});
