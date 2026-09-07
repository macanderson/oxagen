import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// `@oxagen/ai` is the LLM chokepoint the loop is required to go through, so the
// test asserts on the arguments it receives rather than on any provider call.
const streamAgentReply = vi.fn();
const defaultModel = vi.fn(() => ({ modelId: "anthropic/claude-sonnet-5" }));

vi.mock("@oxagen/ai", () => ({
  streamAgentReply: (args: unknown) => streamAgentReply(args),
  defaultModel: () => defaultModel(),
  modelIdOf: (m: unknown) =>
    typeof m === "string" ? m : ((m as { modelId: string }).modelId ?? ""),
  // The real `stepCountIs` builds an SDK StopCondition; a tagged stand-in is
  // enough to prove the cap is passed and at which count.
  stepCountIs: (n: number) => ({ __stepCountIs: n }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: <T,>(_scope: unknown, fn: () => Promise<T> | T) => fn(),
}));

import type { GovernedTurnInput } from "./governed-turn";

const {
  runGovernedTurn,
  serializeMutatingTools,
  aggregateStepUsage,
  buildTurnUserMessage,
  DEFAULT_GOVERNED_TURN_MAX_STEPS,
} = await import("./governed-turn");

type AnyRecord = Record<string, unknown>;

const TELEMETRY = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
  surface: "app" as const,
  messageId: "33333333-3333-3333-3333-333333333333",
};

/** A stand-in LanguageModel: `modelIdOf` is mocked, so only `modelId` matters. */
function fakeModel(modelId: string): GovernedTurnInput["model"] {
  return { modelId } as unknown as GovernedTurnInput["model"];
}

/** Build a fake StreamTextResult over a fixed list of parts. */
function fakeStream(
  parts: unknown[],
  opts: { text?: string; usage?: AnyRecord } = {},
) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    text: Promise.resolve(opts.text ?? ""),
    totalUsage: Promise.resolve(
      opts.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ),
  };
}

function baseInput(over: Partial<GovernedTurnInput> = {}): GovernedTurnInput {
  return {
    telemetry: TELEMETRY,
    system: "SYSTEM",
    history: [{ role: "user", content: "earlier" }],
    instruction: "what did my agents do?",
    tools: {},
    ...over,
  };
}

beforeEach(() => {
  streamAgentReply.mockReset();
  defaultModel.mockClear();
  defaultModel.mockReturnValue({ modelId: "anthropic/claude-sonnet-5" });
});

describe("runGovernedTurn — the tool loop reaches the model", () => {
  it("calls streamAgentReply (never `ai` directly) with the materialised tools", async () => {
    const tools = { list_executions: { description: "d", execute: vi.fn() } };
    streamAgentReply.mockReturnValue(fakeStream([]));

    await runGovernedTurn(
      baseInput({ tools: tools as never }),
    );

    expect(streamAgentReply).toHaveBeenCalledTimes(1);
    const args = streamAgentReply.mock.calls[0]![0] as AnyRecord;
    expect(Object.keys(args["tools"] as AnyRecord)).toEqual(["list_executions"]);
    expect(args["system"]).toBe("SYSTEM");
    expect(args["telemetry"]).toEqual(TELEMETRY);
  });

  it("orders messages history → context → the current user turn", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));

    await runGovernedTurn(
      baseInput({
        contextMessages: [
          { role: "user", content: "## Recalled workspace memory" },
          null,
          undefined,
          { role: "user", content: "## Current page" },
        ],
      }),
    );

    const messages = (streamAgentReply.mock.calls[0]![0] as AnyRecord)[
      "messages"
    ] as Array<{ role: string; content: unknown }>;
    expect(messages.map((m) => m.content)).toEqual([
      "earlier",
      "## Recalled workspace memory",
      "## Current page",
      "what did my agents do?",
    ]);
  });

  it("resolves the model through modelIdOf and reports the id on the result", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));

    const result = await runGovernedTurn(
      baseInput({ model: fakeModel("openai/gpt-5.3") }),
    );

    expect(result.modelId).toBe("openai/gpt-5.3");
    expect(defaultModel).not.toHaveBeenCalled();
  });

  it("falls back to the platform default model when none is supplied", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));

    const result = await runGovernedTurn(
      baseInput(),
    );

    expect(defaultModel).toHaveBeenCalledTimes(1);
    expect(result.modelId).toBe("anthropic/claude-sonnet-5");
  });

  it("forwards reasoning effort only when the caller supplies one", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));
    await runGovernedTurn(
      baseInput({ effort: "high" }),
    );
    expect((streamAgentReply.mock.calls[0]![0] as AnyRecord)["effort"]).toBe(
      "high",
    );

    streamAgentReply.mockReturnValue(fakeStream([]));
    await runGovernedTurn(
      baseInput({ effort: null }),
    );
    expect(streamAgentReply.mock.calls[1]![0] as AnyRecord).not.toHaveProperty(
      "effort",
    );
  });

  it("re-exposes the AI-SDK fullStream unchanged for the surface translators", async () => {
    const parts = [
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "b" },
    ];
    streamAgentReply.mockReturnValue(fakeStream(parts, { text: "ab" }));

    const result = await runGovernedTurn(
      baseInput(),
    );
    const seen: unknown[] = [];
    for await (const p of result.fullStream) seen.push(p);

    expect(seen).toEqual(parts);
    await expect(result.finalText).resolves.toBe("ab");
  });

  it("maps aggregated usage, reading prompt-cache reads from inputTokenDetails", async () => {
    streamAgentReply.mockReturnValue(
      fakeStream([], {
        usage: {
          inputTokens: 900,
          outputTokens: 120,
          totalTokens: 1020,
          inputTokenDetails: { cacheReadTokens: 700 },
        },
      }),
    );

    const result = await runGovernedTurn(
      baseInput(),
    );

    await expect(result.usage).resolves.toEqual({
      inputTokens: 900,
      outputTokens: 120,
      totalTokens: 1020,
      cachedInputTokens: 700,
    });
  });
});

describe("runGovernedTurn — the step cap", () => {
  it("bounds the loop at the default step count", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));

    const result = await runGovernedTurn(
      baseInput(),
    );

    expect((streamAgentReply.mock.calls[0]![0] as AnyRecord)["stopWhen"]).toEqual(
      { __stepCountIs: DEFAULT_GOVERNED_TURN_MAX_STEPS },
    );
    expect(result.maxSteps).toBe(DEFAULT_GOVERNED_TURN_MAX_STEPS);
    expect(result.budgeted).toBe(false);
  });

  it("honours a caller-configured cap", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));

    const result = await runGovernedTurn(
      baseInput({ maxSteps: 3 }),
    );

    expect((streamAgentReply.mock.calls[0]![0] as AnyRecord)["stopWhen"]).toEqual(
      { __stepCountIs: 3 },
    );
    expect(result.maxSteps).toBe(3);
  });

  it("ORs the budget guard alongside the step cap and stops on its verdict", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));
    const budgetGuard = vi.fn().mockResolvedValue("stop");

    const result = await runGovernedTurn(
      baseInput({ budgetGuard }),
    );

    expect(result.budgeted).toBe(true);
    const stopWhen = (streamAgentReply.mock.calls[0]![0] as AnyRecord)[
      "stopWhen"
    ] as unknown[];
    expect(stopWhen).toHaveLength(2);
    expect(stopWhen[0]).toEqual({
      __stepCountIs: DEFAULT_GOVERNED_TURN_MAX_STEPS,
    });

    const budgetStop = stopWhen[1] as (a: {
      steps: unknown[];
    }) => Promise<boolean>;
    await expect(
      budgetStop({
        steps: [
          { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          { usage: { inputTokens: 20, outputTokens: 1, totalTokens: 21 } },
        ],
      }),
    ).resolves.toBe(true);
    expect(budgetGuard).toHaveBeenCalledWith({
      inputTokens: 30,
      outputTokens: 6,
      totalTokens: 36,
      cachedInputTokens: 0,
    });
  });

  it("keeps going when the budget guard says continue", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));
    const budgetGuard = vi.fn().mockResolvedValue("continue");

    await runGovernedTurn(
      baseInput({ budgetGuard }),
    );

    const stopWhen = (streamAgentReply.mock.calls[0]![0] as AnyRecord)[
      "stopWhen"
    ] as unknown[];
    const budgetStop = stopWhen[1] as (a: {
      steps: unknown[];
    }) => Promise<boolean>;
    await expect(budgetStop({ steps: [] })).resolves.toBe(false);
  });
});

describe("runGovernedTurn — approval pauses keep the turn streaming", () => {
  it("emits approval-required before the tool result and never tears the turn down", async () => {
    // The materialised tool is what blocks on waitForApproval; the loop's only
    // duty is to keep the stream open across that pause.
    const order: string[] = [];
    let releaseApproval: (() => void) | undefined;
    const approvalGate = new Promise<void>((res) => {
      releaseApproval = res;
    });

    const tools = {
      delete_agent_def: {
        description: "d",
        execute: async () => {
          order.push("approval-required");
          await approvalGate;
          order.push("tool-executed");
          return { ok: true };
        },
      },
    };

    // The fake stream drives the tool the way the SDK would: dispatch execute,
    // keep yielding text while it is paused, then yield the result.
    streamAgentReply.mockImplementation((args: AnyRecord) => {
      const t = (args["tools"] as AnyRecord)["delete_agent_def"] as {
        execute: () => Promise<unknown>;
      };
      const pending = t.execute();
      return {
        fullStream: (async function* () {
          yield { type: "tool-call", toolCallId: "c1" };
          order.push("streamed-while-paused");
          yield { type: "text-delta", text: "waiting for approval…" };
          releaseApproval?.();
          const output = await pending;
          order.push("streamed-result");
          yield { type: "tool-result", toolCallId: "c1", output };
        })(),
        text: Promise.resolve("done"),
        totalUsage: Promise.resolve({}),
      };
    });

    const result = await runGovernedTurn(
      baseInput({ tools: tools as never }),
    );
    const seen: string[] = [];
    for await (const p of result.fullStream) {
      seen.push((p as { type: string }).type);
    }

    expect(order).toEqual([
      "approval-required",
      "streamed-while-paused",
      "tool-executed",
      "streamed-result",
    ]);
    expect(seen).toEqual(["tool-call", "text-delta", "tool-result"]);
    await expect(result.finalText).resolves.toBe("done");
  });
});

describe("runGovernedTurn — error part propagation", () => {
  it("forwards an error part to the caller's translator instead of throwing", async () => {
    const boom = new Error("gateway 502");
    streamAgentReply.mockReturnValue(
      fakeStream([
        { type: "text-delta", text: "partial" },
        { type: "error", error: boom },
      ]),
    );

    const result = await runGovernedTurn(
      baseInput(),
    );
    const seen: unknown[] = [];
    for await (const p of result.fullStream) seen.push(p);

    expect(seen).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "error", error: boom },
    ]);
  });

  it("forwards the caller's onError hook to the chokepoint", async () => {
    streamAgentReply.mockReturnValue(fakeStream([]));
    const onError = vi.fn();

    await runGovernedTurn(
      baseInput({ onError }),
    );

    expect((streamAgentReply.mock.calls[0]![0] as AnyRecord)["onError"]).toBe(
      onError,
    );
  });

  it("propagates a throw out of the stream to the caller", async () => {
    streamAgentReply.mockReturnValue({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "a" };
        throw new Error("aborted");
      })(),
      text: Promise.resolve(""),
      totalUsage: Promise.resolve({}),
    });

    const result = await runGovernedTurn(
      baseInput(),
    );
    await expect(
      (async () => {
        for await (const _p of result.fullStream) void _p;
      })(),
    ).rejects.toThrow("aborted");
  });
});

/** Read back a wrapped tool's `execute` for direct invocation in a test. */
function executeOf(tool: unknown): () => Promise<unknown> {
  return (tool as { execute: () => Promise<unknown> }).execute;
}

describe("serializeMutatingTools", () => {
  it("returns the same tool set when nothing mutates", () => {
    const tools = { a: { execute: vi.fn() } };
    expect(serializeMutatingTools(tools as never, [])).toBe(tools);
  });

  it("leaves non-mutating tools on the concurrent lane", async () => {
    const order: string[] = [];
    const mk = (name: string, delay: number) => ({
      execute: async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${name}:end`);
      },
    });
    const tools = { read_a: mk("read_a", 10), read_b: mk("read_b", 1) };
    const out = serializeMutatingTools(tools as never, ["write_x"]);

    await Promise.all([
      executeOf(out["read_a"])(),
      executeOf(out["read_b"])(),
    ]);

    // Interleaved: b finished before a, so they genuinely ran side by side.
    expect(order).toEqual([
      "read_a:start",
      "read_b:start",
      "read_b:end",
      "read_a:end",
    ]);
  });

  it("serializes mutating tools against each other", async () => {
    const order: string[] = [];
    const mk = (name: string, delay: number) => ({
      execute: async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${name}:end`);
      },
    });
    const tools = { write_a: mk("write_a", 10), write_b: mk("write_b", 1) };
    const out = serializeMutatingTools(tools as never, ["write_a", "write_b"]);

    await Promise.all([
      executeOf(out["write_a"])(),
      executeOf(out["write_b"])(),
    ]);

    expect(order).toEqual([
      "write_a:start",
      "write_a:end",
      "write_b:start",
      "write_b:end",
    ]);
  });

  it("does not wedge the lane when a mutating tool throws", async () => {
    const after = vi.fn().mockResolvedValue("ok");
    const tools = {
      write_a: {
        execute: async () => {
          throw new Error("denied");
        },
      },
      write_b: { execute: after },
    };
    const out = serializeMutatingTools(tools as never, ["write_a", "write_b"]);

    const first = executeOf(out["write_a"])();
    const second = executeOf(out["write_b"])();

    await expect(first).rejects.toThrow("denied");
    await expect(second).resolves.toBe("ok");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("passes through a tool with no execute closure", () => {
    const tools = { client_side: { description: "d" } };
    const out = serializeMutatingTools(tools as never, ["client_side"]);
    expect(out["client_side"]).toBe(tools.client_side);
  });
});

describe("aggregateStepUsage", () => {
  it("sums nothing to zeroes", () => {
    expect(aggregateStepUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("skips steps that reported no usage and reads either cache spelling", () => {
    expect(
      aggregateStepUsage([
        {},
        { usage: { inputTokens: 5, cachedInputTokens: 2 } },
        { usage: { inputTokens: 5, inputTokenDetails: { cacheReadTokens: 3 } } },
      ]),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 5,
    });
  });
});

describe("buildTurnUserMessage", () => {
  it("is plain text with no attachments", () => {
    expect(buildTurnUserMessage("hello")).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("carries images as image parts and everything else as file parts", () => {
    const png = new Uint8Array([1, 2]);
    const mp4 = new Uint8Array([3, 4]);
    expect(
      buildTurnUserMessage("look", [
        { kind: "image", data: png, mediaType: "image/png" },
        { kind: "file", data: mp4, mediaType: "video/mp4" },
      ]),
    ).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: png, mediaType: "image/png" },
        { type: "file", data: mp4, mediaType: "video/mp4" },
      ],
    });
  });
});
