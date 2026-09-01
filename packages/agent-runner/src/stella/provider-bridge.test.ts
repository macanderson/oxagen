/**
 * The pricing witness for the Stella provider bridge (macanderson/oxagen#2543).
 *
 * `CompletionResult.cost_usd` is what the engine folds into a turn's settled
 * spend, and before the pricer was injectable every completion reported zero —
 * which is why `buildBudgetSpec` refuses to arm anything stronger than
 * `observed` without one. The two cases below are that fix's fail→pass pair:
 * no pricer still reports `0`, and an injected pricer's dollars reach
 * `cost_usd` unrounded, for a pinned usage/model pair.
 *
 * The pricer is asserted on its *arguments* as well as its result, because the
 * bridge is the only place the AI SDK's usage shape is translated into the one
 * `@oxagen/billing` is called with — a bridge that priced the wrong token
 * counts would still return a plausible non-zero number.
 *
 * House style: a hand-rolled `AgentAi` fake, no `vi.mock` — the port is three
 * promises and a stream, so a fake is smaller than a mock and says what it
 * returns.
 */
import { describe, it, expect, vi } from "vitest";
import type { AgentAi } from "@oxagen/agent-engine";
import type { CompletionRequest } from "@oxagen/stella-engine-client";
import { createProviderHandler, toCompletionUsage } from "./provider-bridge";

/** A one-completion `AgentAi` whose usage is whatever the case needs. */
function fakeAi(usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
}): AgentAi {
  return {
    stream: () => ({
      fullStream: (async function* () {})(),
      text: Promise.resolve("ok"),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(usage),
      finishReason: Promise.resolve("stop"),
    }),
  } as unknown as AgentAi;
}

const REQUEST = {
  messages: [],
  effort: undefined,
} as unknown as CompletionRequest;

const BASE = {
  model: "claude-sonnet-4-5",
  system: "you are a worker",
  tools: {},
} as const;

describe("createProviderHandler — cost_usd", () => {
  it("reports zero when no pricer is injected", async () => {
    // The pre-fix state: the engine is told every call was free, so an
    // `enforced` ceiling could never be reached.
    const handler = createProviderHandler({
      ...BASE,
      ai: fakeAi({ inputTokens: 1000, outputTokens: 500 }),
    });

    const result = await handler(REQUEST);

    expect(result.cost_usd).toBe(0);
  });

  it("reports the injected pricer's dollars for a pinned usage/model pair", async () => {
    const price = vi.fn(() => 0.0123);
    const handler = createProviderHandler({
      ...BASE,
      ai: fakeAi({
        inputTokens: 1000,
        outputTokens: 500,
        inputTokenDetails: { cacheReadTokens: 200 },
      }),
      price,
    });

    const result = await handler(REQUEST);

    expect(result.cost_usd).toBe(0.0123);
    // The token counts the host prices are the ones that came back, not the
    // ones that were asked for.
    expect(price).toHaveBeenCalledWith({
      model: "claude-sonnet-4-5",
      usage: {
        reported: true,
        input_tokens: 1000,
        output_tokens: 500,
        cached_input_tokens: 200,
      },
    });
  });

  it("passes a zero-dollar price through rather than treating it as absent", async () => {
    // A free-tier or zero-rated model prices at 0. That is a priced call, and
    // it must not be indistinguishable from "no pricer" anywhere downstream.
    const price = vi.fn(() => 0);
    const handler = createProviderHandler({
      ...BASE,
      ai: fakeAi({ inputTokens: 10, outputTokens: 0 }),
      price,
    });

    const result = await handler(REQUEST);

    expect(result.cost_usd).toBe(0);
    expect(price).toHaveBeenCalledTimes(1);
  });

  it("prices once per completion", async () => {
    const price = vi.fn(() => 0.5);
    const handler = createProviderHandler({
      ...BASE,
      ai: fakeAi({ inputTokens: 1, outputTokens: 1 }),
      price,
    });

    await handler(REQUEST);

    expect(price).toHaveBeenCalledTimes(1);
  });
});

describe("toCompletionUsage", () => {
  it("defaults missing counts to zero and omits cache reads it never saw", () => {
    // `cached_input_tokens` absent means "the provider did not report one",
    // which a pricer must be able to tell from a reported zero.
    expect(toCompletionUsage({})).toEqual({
      reported: true,
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("carries a reported cache read through, including zero", () => {
    expect(
      toCompletionUsage({
        inputTokens: 7,
        outputTokens: 3,
        inputTokenDetails: { cacheReadTokens: 0 },
      }),
    ).toEqual({
      reported: true,
      input_tokens: 7,
      output_tokens: 3,
      cached_input_tokens: 0,
    });
  });
});
