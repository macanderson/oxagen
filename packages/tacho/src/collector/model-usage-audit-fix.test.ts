import { describe, expect, it } from "vitest";
import {
  callCeilingMicros,
  priceObservedUsage,
  resolveModelPrice,
  resolveModelPriceMatch,
} from "./model-pricing";
import { estimateCutUsage, UsageMeter } from "./model-usage";

const SSE = "text/event-stream";

function sse(events: Array<[string | undefined, unknown]>): string {
  return events
    .map(
      ([name, data]) =>
        `${name !== undefined ? `event: ${name}\n` : ""}data: ${
          typeof data === "string" ? data : JSON.stringify(data)
        }\n\n`,
    )
    .join("");
}

function feed(meter: UsageMeter, body: string, size = 5): void {
  const bytes = Buffer.from(body, "utf8");
  for (let at = 0; at < bytes.length; at += size)
    meter.write(bytes.subarray(at, at + size));
}

const START = [
  "message_start",
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "claude-sonnet-5",
      usage: { input_tokens: 900, output_tokens: 1 },
    },
  },
] as [string, unknown];

describe("a stream that ends in an error", () => {
  it("keeps Anthropic's event: error as the stream's error, and counts it as the ending", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    feed(
      meter,
      sse([
        START,
        [
          "error",
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ],
      ]),
    );
    const usage = meter.end();
    expect(usage.streamError).toBe("overloaded_error");
    expect(usage.inputTokens).toBe(900);
    expect(meter.cutShort).toBe(false);
  });

  it("reads status, model and id off response.failed whose usage is null", () => {
    const meter = new UsageMeter("openai.responses", SSE);
    feed(
      meter,
      sse([
        [
          "response.failed",
          {
            type: "response.failed",
            response: {
              id: "resp_9",
              model: "gpt-5",
              status: "failed",
              error: { code: "server_error", message: "boom" },
              usage: null,
            },
          },
        ],
      ]),
    );
    expect(meter.end()).toEqual({
      model: "gpt-5",
      responseId: "resp_9",
      stopReason: "failed",
      streamError: "server_error",
    });
    expect(meter.cutShort).toBe(false);
  });

  it("keeps a Responses error event's code, slugged", () => {
    const meter = new UsageMeter("openai.responses", SSE);
    feed(
      meter,
      sse([["error", { type: "error", code: "rate limit/exceeded" }]]),
    );
    expect(meter.end().streamError).toBe("rate_limit_exceeded");
  });

  it("does not take the text of a delta for an error", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    feed(
      meter,
      sse([
        START,
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: '{"type":"error"} response.failed',
            },
          },
        ],
      ]),
    );
    expect(meter.end().streamError).toBeUndefined();
  });
});

describe("a stream cut before its closing count", () => {
  const text = "x".repeat(400);

  it("says an Anthropic stream cut before message_delta is short, and measures the text it carried", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    feed(
      meter,
      sse([
        START,
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{\\"a\\":1}' },
          },
        ],
      ]),
    );
    const usage = meter.end();
    expect(meter.cutShort).toBe(true);
    // 400 bytes of text, and the escaped JSON as it crossed the wire.
    expect(meter.contentBytes).toBe(
      400 + JSON.stringify('{\\"a\\":1}').length - 2,
    );
    const estimated = estimateCutUsage(usage, meter.contentBytes, 8000);
    expect(estimated.outputTokens).toBe(Math.ceil(meter.contentBytes / 4));
    // The vendor said the input, so it is not guessed.
    expect(estimated.inputTokens).toBe(900);
  });

  it("is not short once the closing count came", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    feed(
      meter,
      sse([
        START,
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
        ],
      ]),
    );
    meter.end();
    expect(meter.cutShort).toBe(false);
  });

  it("estimates the input of a cut Responses stream from the request, since it said nothing", () => {
    const meter = new UsageMeter("openai.responses", SSE);
    feed(
      meter,
      sse([
        [
          "response.output_text.delta",
          {
            type: "response.output_text.delta",
            delta: text,
            obfuscation: "padding-that-is-not-output",
          },
        ],
      ]),
    );
    const usage = meter.end();
    expect(meter.cutShort).toBe(true);
    expect(meter.contentBytes).toBe(400);
    expect(estimateCutUsage(usage, meter.contentBytes, 4001)).toMatchObject({
      inputTokens: 1001,
      outputTokens: 100,
    });
  });

  it("counts a chat stream that reached [DONE] as ended, with or without usage", () => {
    const meter = new UsageMeter("openai.chat", SSE);
    feed(
      meter,
      sse([
        [undefined, { choices: [{ delta: { content: text } }], usage: null }],
        [undefined, "[DONE]"],
      ]),
    );
    meter.end();
    expect(meter.contentBytes).toBe(400);
    expect(meter.cutShort).toBe(false);
    const cut = new UsageMeter("openai.chat", SSE);
    feed(cut, sse([[undefined, { choices: [{ delta: { content: text } }] }]]));
    cut.end();
    expect(cut.cutShort).toBe(true);
  });

  it("is never short for an unstreamed document or a route that is not metered", () => {
    const plain = new UsageMeter("anthropic.messages", "application/json");
    feed(plain, '{"id":"msg_1","usage":');
    plain.end();
    expect(plain.cutShort).toBe(false);
    const other = new UsageMeter("other", SSE);
    feed(other, sse([START]));
    other.end();
    expect(other.cutShort).toBe(false);
  });
});

describe("which price row a model reaches", () => {
  const row = (provider: "anthropic" | "openai", model: string, input = 1) => ({
    provider,
    model,
    input,
    output: input * 5,
    cache_read: 0,
    cache_write: 0,
  });
  const prices = [
    row("anthropic", "claude-opus-4", 15),
    row("anthropic", "claude-opus-4-5", 5),
    row("anthropic", "claude-opus", 7),
    row("anthropic", "claude-sonnet-5", 3),
    row("openai", "gpt-5", 1),
    row("openai", "gpt-4", 30),
    row("openai", "gpt-4o", 2),
  ];
  const at = (provider: "anthropic" | "openai", model: string) => {
    const match = resolveModelPriceMatch(prices, provider, model);
    return match === undefined
      ? undefined
      : `${match.price.model}${match.family ? " (family)" : ""}`;
  };

  it("prices a model by its own row or its row plus a date stamp", () => {
    expect(at("anthropic", "claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(at("anthropic", "claude-opus-4-20250514")).toBe("claude-opus-4");
    expect(at("anthropic", "claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
    expect(at("anthropic", "claude-sonnet-5-latest")).toBe("claude-sonnet-5");
    expect(at("openai", "gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(at("openai", "gpt-4-0613")).toBe("gpt-4");
    expect(at("anthropic", "anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
  });

  it("never lets a version's row price a later version, and falls to the family row marked as such", () => {
    // `claude-opus-4` used to price 4-6 through 4-8 by prefix.
    expect(at("anthropic", "claude-opus-4-7")).toBe("claude-opus (family)");
    expect(at("anthropic", "claude-opus-5")).toBe("claude-opus (family)");
    expect(at("anthropic", "claude-opusx")).toBeUndefined();
    expect(at("openai", "gpt-5.2")).toBeUndefined();
    expect(at("openai", "gpt-5-codex")).toBeUndefined();
    expect(at("openai", "gpt-4o-mini")).toBeUndefined();
    expect(resolveModelPrice(prices, "openai", "gpt-4o-mini")).toBeUndefined();
  });

  it("takes a row ending in * as a family row", () => {
    const starred = [row("openai", "gpt-5*", 2), row("openai", "gpt-5", 1)];
    expect(resolveModelPriceMatch(starred, "openai", "gpt-5")).toMatchObject({
      price: { model: "gpt-5" },
      family: false,
    });
    expect(
      resolveModelPriceMatch(starred, "openai", "gpt-5-codex"),
    ).toMatchObject({ price: { model: "gpt-5*" }, family: true });
    expect(
      priceObservedUsage(starred, "openai", {
        model: "gpt-5.2",
        outputTokens: 1_000_000,
      }),
    ).toBe(10);
  });
});

describe("the ceiling a call holds while in flight", () => {
  const prices = [
    {
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
      input: 3_000_000,
      output: 15_000_000,
      cache_read: 300_000,
      cache_write: 3_750_000,
    },
  ];

  it("prices the request bytes as input and the stated output cap as output", () => {
    // 7000 bytes is 2000 tokens at 3.5 a token: $0.006, and 1000 out is $0.015.
    expect(
      callCeilingMicros(prices, "anthropic", "claude-sonnet-5", 7000, 1000),
    ).toBe(6000 + 15_000);
    // No cap stated: 4096 tokens of output.
    expect(
      callCeilingMicros(prices, "anthropic", "claude-sonnet-5", 0, undefined),
    ).toBe(4096 * 15);
    // Unpriced holds nothing, the way it costs nothing when it settles.
    expect(callCeilingMicros(prices, "anthropic", "mystery", 7000, 1000)).toBe(
      0,
    );
  });
});
