import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  priceObservedUsage,
  resolveModelPrice,
  usdToMicros,
} from "./model-pricing";
import {
  withAnthropicSystemBlock,
  withOpenAiInstructions,
} from "./model-injection";
import { decoderFor, hasTokenCounts, UsageMeter } from "./model-usage";

const SSE = "text/event-stream; charset=utf-8";
const SECRET_TEXT = "the quick brown completion";

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

/** Feed a body in awkward pieces, so no line arrives whole. */
function feed(meter: UsageMeter, body: string, size = 7): void {
  const bytes = Buffer.from(body, "utf8");
  for (let at = 0; at < bytes.length; at += size)
    meter.write(bytes.subarray(at, at + size));
}

const ANTHROPIC_STREAM = sse([
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_01",
        model: "claude-sonnet-5-20260101",
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 4000,
          cache_creation: {
            ephemeral_5m_input_tokens: 100,
            ephemeral_1h_input_tokens: 200,
          },
          service_tier: "standard",
        },
      },
    },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", delta: { text: `${SECRET_TEXT} "usage"` } },
  ],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 57 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]);

describe("Anthropic Messages", () => {
  it("reads message_start and the cumulative message_delta from a stream", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    expect(meter.isStreaming).toBe(true);
    feed(meter, ANTHROPIC_STREAM);
    expect(meter.end()).toEqual({
      model: "claude-sonnet-5-20260101",
      responseId: "msg_01",
      stopReason: "end_turn",
      serviceTier: "standard",
      inputTokens: 12,
      outputTokens: 57,
      cacheReadTokens: 4000,
      cacheCreationTokens: 300,
      cacheCreation5mTokens: 100,
      cacheCreation1hTokens: 200,
    });
  });

  it("reports what the vendor had said when the stream is cut short", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    feed(
      meter,
      ANTHROPIC_STREAM.slice(0, ANTHROPIC_STREAM.indexOf("message_delta")),
    );
    const usage = meter.end();
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(1);
    expect(usage.stopReason).toBeUndefined();
  });

  it("lets a later delta overwrite the input and cache counts it names", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    feed(
      meter,
      `${ANTHROPIC_STREAM}${sse([
        [
          "message_delta",
          {
            type: "message_delta",
            usage: {
              input_tokens: 20,
              cache_read_input_tokens: 1,
              output_tokens: 60,
            },
          },
        ],
      ])}`,
    );
    expect(meter.end()).toMatchObject({
      inputTokens: 20,
      cacheReadTokens: 1,
      outputTokens: 60,
    });
  });

  it("reads the usage of an unstreamed document", () => {
    const meter = new UsageMeter("anthropic.messages", "application/json");
    feed(
      meter,
      JSON.stringify({
        id: "msg_02",
        type: "message",
        model: "claude-haiku-5",
        stop_reason: "tool_use",
        content: [{ type: "text", text: SECRET_TEXT }],
        usage: {
          input_tokens: 9,
          output_tokens: 3,
          cache_read_input_tokens: 2,
        },
      }),
    );
    expect(meter.end()).toEqual({
      model: "claude-haiku-5",
      responseId: "msg_02",
      stopReason: "tool_use",
      inputTokens: 9,
      outputTokens: 3,
      cacheReadTokens: 2,
    });
  });
});

describe("OpenAI", () => {
  const usage = {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 800 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 30 },
    total_tokens: 1050,
  };

  it("reads response.completed from a Responses stream, cached tokens moved out of input", () => {
    const meter = new UsageMeter("openai.responses", SSE);
    feed(
      meter,
      sse([
        [
          "response.created",
          { type: "response.created", response: { id: "resp_1" } },
        ],
        [
          "response.output_text.delta",
          { type: "response.output_text.delta", delta: SECRET_TEXT },
        ],
        [
          "response.completed",
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              model: "gpt-5",
              status: "completed",
              usage,
            },
          },
        ],
      ]),
    );
    expect(meter.end()).toEqual({
      model: "gpt-5",
      responseId: "resp_1",
      stopReason: "completed",
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      thinkingTokens: 30,
    });
  });

  it("knows a stream by how it starts when the vendor does not declare one", () => {
    // The ChatGPT Codex backend streams `/responses` with no event-stream type.
    const meter = new UsageMeter("openai.responses", undefined);
    expect(meter.isStreaming).toBe(false);
    feed(
      meter,
      sse([
        [
          "response.completed",
          { type: "response.completed", response: { model: "gpt-5", usage } },
        ],
      ]),
    );
    expect(meter.isStreaming).toBe(true);
    expect(meter.end()).toMatchObject({ inputTokens: 200, outputTokens: 50 });
  });

  it("reads response.incomplete, and the unstreamed Responses document", () => {
    const meter = new UsageMeter("openai.responses", SSE);
    feed(
      meter,
      sse([
        [
          "response.incomplete",
          {
            type: "response.incomplete",
            response: { model: "gpt-5", status: "incomplete", usage },
          },
        ],
      ]),
    );
    expect(meter.end().stopReason).toBe("incomplete");
    const plain = new UsageMeter("openai.responses", "application/json");
    feed(
      plain,
      JSON.stringify({
        id: "resp_2",
        object: "response",
        model: "gpt-5-mini",
        status: "completed",
        usage,
      }),
    );
    expect(plain.end()).toMatchObject({
      model: "gpt-5-mini",
      inputTokens: 200,
      cacheReadTokens: 800,
    });
  });

  const chatUsage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 5 },
  };

  it("reads the final usage chunk of a chat stream that asked for include_usage", () => {
    const meter = new UsageMeter("openai.chat", SSE);
    feed(
      meter,
      sse([
        [
          undefined,
          {
            id: "chatcmpl-1",
            model: "gpt-5",
            choices: [{ delta: { content: SECRET_TEXT } }],
            usage: null,
          },
        ],
        [
          undefined,
          { id: "chatcmpl-1", model: "gpt-5", choices: [], usage: chatUsage },
        ],
        [undefined, "[DONE]"],
      ]),
    );
    expect(meter.end()).toEqual({
      model: "gpt-5",
      responseId: "chatcmpl-1",
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      thinkingTokens: 5,
    });
  });

  it("reports no usage for a chat stream that did not ask for it", () => {
    const meter = new UsageMeter("openai.chat", SSE);
    feed(
      meter,
      sse([
        [
          undefined,
          { id: "c", model: "gpt-5", choices: [{ delta: { content: "hi" } }] },
        ],
        [undefined, "[DONE]"],
      ]),
    );
    const seen = meter.end();
    expect(hasTokenCounts(seen)).toBe(false);
    expect(seen).toEqual({});
  });

  it("reads an unstreamed chat completion", () => {
    const meter = new UsageMeter("openai.chat", "application/json");
    feed(
      meter,
      JSON.stringify({
        id: "chatcmpl-2",
        model: "gpt-5",
        choices: [],
        usage: chatUsage,
        service_tier: "default",
      }),
    );
    expect(meter.end()).toMatchObject({
      inputTokens: 60,
      serviceTier: "default",
    });
  });
});

describe("what the meter refuses to hold", () => {
  it("ignores every route that is not a model call", () => {
    const meter = new UsageMeter("other", "application/json");
    feed(meter, JSON.stringify({ usage: { input_tokens: 1 } }));
    expect(meter.end()).toEqual({});
  });

  it("skips a line longer than it will hold and keeps reading after it", () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    meter.write(Buffer.from(`data: {"usage":"${"x".repeat(1_100_000)}"}\n`));
    feed(meter, ANTHROPIC_STREAM, 4096);
    expect(meter.end().outputTokens).toBe(57);
  });

  it("reads usage from a response.completed line bigger than the old 1 MiB cap (P2-11)", () => {
    const meter = new UsageMeter("openai.responses", SSE);
    // Bigger than the old `MAX_LINE_BYTES` (1 MiB), under the new one: a
    // `response.completed` line carries the whole response's `output`
    // alongside its usage block, and dropping the line wholesale past 1 MiB
    // used to drop the usage with it.
    const padding = "x".repeat(1_200_000);
    const event = {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        model: "gpt-5",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: padding }],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 22 },
      },
    };
    feed(meter, `data: ${JSON.stringify(event)}\n\n`, 4096);
    const usage = meter.end();
    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(22);
  });

  it("gives up on a document past its cap, and on one that is not JSON", () => {
    const big = new UsageMeter("anthropic.messages", "application/json");
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < 17; i += 1) big.write(chunk);
    big.write(Buffer.from('{"usage":{"input_tokens":1}}'));
    expect(big.end()).toEqual({});
    const html = new UsageMeter("anthropic.messages", "text/html");
    html.write(Buffer.from('<html>"usage"</html>'));
    expect(html.end()).toEqual({});
    const broken = new UsageMeter("anthropic.messages", SSE);
    broken.write(Buffer.from('data: {"usage": nope\n\ndata: [1]\n\nevent: x'));
    expect(broken.end()).toEqual({});
  });

  it("decodes a response the upstream compressed anyway", async () => {
    const meter = new UsageMeter("anthropic.messages", SSE);
    const decoder = decoderFor("gzip");
    expect(decoder).toBeDefined();
    decoder!.on("data", (chunk: Buffer) => meter.write(chunk));
    const done = new Promise((resolve) => decoder!.once("end", resolve));
    decoder!.end(gzipSync(Buffer.from(ANTHROPIC_STREAM)));
    await done;
    expect(meter.end().outputTokens).toBe(57);
    expect(decoderFor("br")).toBeDefined();
    expect(decoderFor("deflate")).toBeDefined();
    expect(decoderFor("zstd")).toBeDefined();
    expect(decoderFor("identity")).toBeUndefined();
    expect(decoderFor(undefined)).toBeUndefined();
  });
});

describe("pricing an observed call", () => {
  const prices = [
    {
      provider: "anthropic" as const,
      model: "claude-sonnet",
      input: 3_000_000,
      output: 15_000_000,
      cache_read: 300_000,
      cache_write: 3_750_000,
      cache_write_1h: 6_000_000,
    },
    {
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
      input: 4_000_000,
      output: 20_000_000,
      cache_read: 400_000,
      cache_write: 5_000_000,
    },
    {
      provider: "openai" as const,
      model: "gpt-5",
      input: 1_250_000,
      output: 10_000_000,
      cache_read: 125_000,
      cache_write: 1_250_000,
    },
  ];

  it("takes the longest prefix within the provider, bare or gateway-style", () => {
    expect(
      resolveModelPrice(prices, "anthropic", "claude-sonnet-5-20260101")?.model,
    ).toBe("claude-sonnet-5");
    expect(
      resolveModelPrice(prices, "anthropic", "anthropic/claude-sonnet-4")
        ?.model,
    ).toBe("claude-sonnet");
    expect(
      resolveModelPrice(prices, "openai", "claude-sonnet-5"),
    ).toBeUndefined();
    expect(resolveModelPrice(prices, "openai", undefined)).toBeUndefined();
    expect(resolveModelPrice(undefined, "openai", "gpt-5")).toBeUndefined();
  });

  it("prices each token class, one-hour cache writes at their own rate", () => {
    expect(
      priceObservedUsage(prices, "anthropic", {
        model: "claude-sonnet-4",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        cacheCreation1hTokens: 1_000_000,
      }),
    ).toBe(3_000_000 + 15_000_000 + 300_000 + 3_750_000 + 6_000_000);
    expect(
      priceObservedUsage(prices, "openai", {
        model: "gpt-5",
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 800,
      }),
    ).toBe(850);
    expect(
      priceObservedUsage(prices, "openai", { model: "o9", inputTokens: 1 }),
    ).toBeUndefined();
    expect(usdToMicros(0.25)).toBe(250_000);
  });
});

describe("the two edits the injection seam exists for", () => {
  it("appends an Anthropic system block whatever shape system had", () => {
    expect(withAnthropicSystemBlock({ model: "m" }, "steer")).toEqual({
      model: "m",
      system: [{ type: "text", text: "steer" }],
    });
    expect(
      withAnthropicSystemBlock({ system: "mine" }, "steer").system,
    ).toEqual([
      { type: "text", text: "mine" },
      { type: "text", text: "steer" },
    ]);
    const blocks = [
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
    ];
    expect(
      withAnthropicSystemBlock({ system: blocks }, "steer").system,
    ).toEqual([...blocks, { type: "text", text: "steer" }]);
  });

  it("adds OpenAI instructions, or a system message for chat", () => {
    expect(withOpenAiInstructions({ input: [] }, "steer")).toEqual({
      input: [],
      instructions: "steer",
    });
    expect(
      withOpenAiInstructions({ instructions: "mine" }, "steer").instructions,
    ).toBe("mine\n\nsteer");
    expect(
      withOpenAiInstructions(
        {
          messages: [
            { role: "system", content: "s" },
            { role: "user", content: "u" },
          ],
        },
        "steer",
      ).messages,
    ).toEqual([
      { role: "system", content: "s" },
      { role: "system", content: "steer" },
      { role: "user", content: "u" },
    ]);
  });
});
