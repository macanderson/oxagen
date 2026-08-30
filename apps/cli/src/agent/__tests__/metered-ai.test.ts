/**
 * Tests for the metered AI port wrapper — the seam that gives every engine model
 * call a per-call timeout (Bug 1) and a live metrics event (Bug 2).
 *
 * The key guarantee: evaluator ("enhancer"), worker, and judge calls ALL flow
 * through the port, so all three contribute to the metrics totals. A regression
 * that routed one path around the port would drop its event — asserted here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  AgentAi,
  ObjectRunArgs,
  ObjectRunResult,
} from "@oxagen/agent-engine";

// Mock the CLI debug channel so we can assert an onMetrics failure is surfaced
// (not swallowed) while an aborted-turn usage rejection stays silent.
const debugLogMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/debug-log.js", () => ({ debugLog: debugLogMock }));

import { createMeteredAi } from "../metered-ai.js";
import type { MetricsEvent } from "../metrics.js";
import { AgentTimeoutError } from "../timeouts.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A fake stream result exposing only what the wrapper touches: `usage`. */
function fakeStream(usage: { inputTokens: number; outputTokens: number }): {
  usage: Promise<{ inputTokens: number; outputTokens: number }>;
} {
  return { usage: Promise.resolve(usage) };
}

/** Build a fake AgentAi whose behaviour the test controls. */
function makeFakeAi(overrides: Partial<AgentAi> = {}): AgentAi {
  const base: AgentAi = {
    // The wrapper only reads `.usage` off the stream result; the fake exposes
    // just that, cast through `unknown` since it isn't a full StreamRunResult.
    stream: ((_args) =>
      fakeStream({
        inputTokens: 500,
        outputTokens: 200,
      }) as unknown) as AgentAi["stream"],
    generateObject: (async <T>(
      args: ObjectRunArgs<T>,
    ): Promise<ObjectRunResult<T>> => ({
      object: {} as T,
      usage: { inputTokens: 100, outputTokens: 50 },
    })) as AgentAi["generateObject"],
  };
  return { ...base, ...overrides };
}

describe("createMeteredAi", () => {
  it("emits a priced metrics event when generateObject completes", async () => {
    const events: MetricsEvent[] = [];
    const ai = createMeteredAi(makeFakeAi(), {
      onMetrics: (ev) => events.push(ev),
      now: () => 1000,
    });
    const res = await ai.generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: {} as never,
      prompt: "x",
    });
    expect(res.usage.inputTokens).toBe(100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "model_call",
      model: "anthropic/claude-sonnet-5",
      tokensIn: 100,
      tokensOut: 50,
      cachedTokens: 0,
      at: 1000,
    });
    // Priced via the rate card → a non-zero cost for a paid model.
    expect(events[0]!.costUsd).toBeGreaterThan(0);
  });

  it("emits a metrics event when a stream's usage settles", async () => {
    const events: MetricsEvent[] = [];
    const ai = createMeteredAi(makeFakeAi(), {
      onMetrics: (ev) => events.push(ev),
    });
    const result = ai.stream({
      model: "anthropic/claude-opus-4",
      system: "s",
      messages: [],
      tools: {},
      stopWhen: (() => false) as never,
    });
    await result.usage; // let the settle handler run
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tokensIn: 500,
      tokensOut: 200,
      cachedTokens: 0,
      kind: "model_call",
    });
  });

  it("flattens a stream's nested cache-read usage into the metrics event, priced at the discounted rate (Bug: live dock was missing cache tokens)", async () => {
    const events: MetricsEvent[] = [];
    const ai = createMeteredAi(
      makeFakeAi({
        // AI SDK v7 shape: cache reads nest under inputTokenDetails, not a flat field.
        stream: ((_args) =>
          ({
            usage: Promise.resolve({
              inputTokens: 1_000_000,
              outputTokens: 0,
              inputTokenDetails: { cacheReadTokens: 1_000_000 },
            }),
          }) as unknown) as AgentAi["stream"],
      }),
      { onMetrics: (ev) => events.push(ev) },
    );
    const result = ai.stream({
      model: "anthropic/claude-sonnet-4.6",
      system: "s",
      messages: [],
      tools: {},
      stopWhen: (() => false) as never,
    });
    await result.usage;
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]!.cachedTokens).toBe(1_000_000);
    // 1M cached @ Sonnet's $0.3/1M cached rate = $0.30, not $3.00 (the fresh rate).
    expect(events[0]!.costUsd).toBeCloseTo(0.3);
  });

  it("flattens a generateObject call's nested cache-read usage into the metrics event", async () => {
    const events: MetricsEvent[] = [];
    const ai = createMeteredAi(
      makeFakeAi({
        generateObject: (async <T>(
          _args: ObjectRunArgs<T>,
        ): Promise<ObjectRunResult<T>> => ({
          object: {} as T,
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 0,
            cachedInputTokens: 1_000_000,
          },
        })) as AgentAi["generateObject"],
      }),
      { onMetrics: (ev) => events.push(ev) },
    );
    await ai.generateObject({
      model: "anthropic/claude-sonnet-4.6",
      schema: {} as never,
      prompt: "x",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.cachedTokens).toBe(1_000_000);
    expect(events[0]!.costUsd).toBeCloseTo(0.3);
  });

  it("records evaluator + worker + judge — every path contributes", async () => {
    const events: MetricsEvent[] = [];
    const ai = createMeteredAi(makeFakeAi(), {
      onMetrics: (ev) => events.push(ev),
    });

    // Simulate a turn: evaluate (generateObject) → worker (stream) → judge (generateObject).
    await ai.generateObject({
      model: "eval/model",
      schema: {} as never,
      prompt: "e",
    });
    await ai.stream({
      model: "worker/model",
      system: "s",
      messages: [],
      tools: {},
      stopWhen: (() => false) as never,
    }).usage;
    await ai.generateObject({
      model: "judge/model",
      schema: {} as never,
      prompt: "j",
    });
    await Promise.resolve();

    const models = events.map((e) => e.model).sort();
    expect(models).toEqual(["eval/model", "judge/model", "worker/model"]);
    // Dropping any one path would leave < 3 events → this assertion fails.
    expect(events).toHaveLength(3);
  });

  it("logs when a stream's onMetrics throws — a real emit failure is NOT swallowed by the usage-rejection catch", async () => {
    debugLogMock.mockClear();
    const ai = createMeteredAi(makeFakeAi(), {
      onMetrics: () => {
        throw new Error("emit boom");
      },
    });

    const result = ai.stream({
      model: "anthropic/claude-opus-4",
      system: "s",
      messages: [],
      tools: {},
      stopWhen: (() => false) as never,
    });
    await result.usage;
    await Promise.resolve();

    const call = debugLogMock.mock.calls.find(
      (c) => c[1] === "metrics.emit-failed",
    );
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("error");
    expect((call?.[2] as { message: string }).message).toContain("emit boom");
  });

  it("stays silent (no debug log, no onMetrics) when a stream's usage promise rejects — aborted turn", async () => {
    debugLogMock.mockClear();
    const onMetrics = vi.fn();
    const ai = createMeteredAi(
      makeFakeAi({
        stream: ((_args) =>
          ({
            usage: Promise.reject(new Error("aborted")),
          }) as unknown) as AgentAi["stream"],
      }),
      { onMetrics },
    );

    const result = ai.stream({
      model: "anthropic/claude-opus-4",
      system: "s",
      messages: [],
      tools: {},
      stopWhen: (() => false) as never,
    });
    // Attach our own handler so the rejection is observed by the test without
    // surfacing as unhandled; the wrapper attaches its own swallowing catch.
    // `usage` is a PromiseLike, so adopt it via Promise.resolve before catching.
    await Promise.resolve(result.usage).catch(() => {});
    await Promise.resolve();

    expect(onMetrics).not.toHaveBeenCalled();
    expect(
      debugLogMock.mock.calls.find((c) => c[1] === "metrics.emit-failed"),
    ).toBeUndefined();
  });

  it("bounds a generateObject call per-call and retries on timeout", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    let attempts = 0;
    const ai = createMeteredAi(
      makeFakeAi({
        generateObject: (async <T>(
          args: ObjectRunArgs<T>,
        ): Promise<ObjectRunResult<T>> => {
          attempts++;
          if (attempts === 1) {
            // First attempt hangs until its per-call deadline aborts the signal.
            return new Promise<ObjectRunResult<T>>((_resolve, reject) => {
              args.abortSignal?.addEventListener(
                "abort",
                () => reject(new AgentTimeoutError("aborted", 1_000)),
                { once: true },
              );
            });
          }
          return {
            object: {} as T,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }) as AgentAi["generateObject"],
      }),
      {
        timeouts: {
          perModelCallMs: 1_000,
          retry: { maxRetries: 2, backoffMs: 0 },
        },
        onLog: (l) => logs.push(l),
      },
    );

    const promise = ai.generateObject({
      model: "m",
      schema: {} as never,
      prompt: "p",
    });
    await vi.advanceTimersByTimeAsync(1_001); // trip attempt 1's deadline
    const res = await promise;
    expect(attempts).toBe(2);
    expect(res.usage.inputTokens).toBe(10);
    expect(
      logs.some(
        (l) => l.includes("scope=model_call") && l.includes("action=retry"),
      ),
    ).toBe(true);
  });
});
