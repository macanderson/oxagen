// The edges of the model-stream fold: documents and chunks that are partly
// malformed, that leave a member out, or that take the less common branch of
// each vendor's shape. Each case says what the transcript shows for it, so a
// fold that silently drops a block or invents one fails here.
import { describe, expect, it } from "vitest";
import {
  assembleModelStream,
  decodeAssembly,
  encodeAssembly,
  type ToolUseBlock,
} from "./content-blocks";

const sse = (events: readonly unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

describe("a non-streamed Anthropic message", () => {
  it("skips what is not a block, keeps thinking, and reads a tool call with no input", () => {
    const assembly = assembleModelStream(
      JSON.stringify({
        type: "message",
        content: [
          null,
          "not a block",
          { type: "thinking", thinking: "check the file first" },
          { type: "tool_result", content: "never in a reply" },
          { type: "text" },
          { type: "tool_use", id: "toolu_1", name: "Read" },
          { type: "text", text: "Done." },
        ],
        stop_reason: "end_turn",
      }),
    );
    expect(assembly?.blocks.map((block) => block.kind)).toEqual([
      "thinking",
      "tool_use",
      "text",
    ]);
    const tool = assembly?.blocks[1] as ToolUseBlock;
    expect(tool.name).toBe("Read");
    expect(tool.callKey).toBe("toolu_1");
    expect(assembly?.stopReason).toBe("end_turn");
    // No usage block: every figure is unknown, not zero.
    expect(assembly?.usage).toEqual({
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
    });
    expect(assembly?.wire.events).toBe(1);
  });
});

describe("a non-streamed OpenAI Responses document", () => {
  it("reads reasoning summaries, refusals, and a tool call whose arguments are not text", () => {
    const assembly = assembleModelStream(
      JSON.stringify({
        object: "response",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          null,
          { type: "reasoning", summary: [{ text: "plan the edit" }, {}] },
          { type: "message", content: "not a list" },
          { type: "message", content: [{ refusal: "I cannot do that." }] },
          { type: "function_call", name: "shell", call_id: "c1", arguments: 7 },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
    expect(assembly?.blocks.map((block) => block.kind)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
    expect(assembly?.stopReason).toBe("max_output_tokens");
    // No cached-token detail: the input is the whole prompt.
    expect(assembly?.usage.inputTokens).toBe(100);
    expect(assembly?.usage.cacheReadTokens).toBeNull();
    const tool = assembly?.blocks[2] as ToolUseBlock;
    expect(tool.callKey).toBe("c1");
    expect(tool.name).toBe("shell");
  });

  it("falls back to the status for the stop reason, and reads no input when none was reported", () => {
    const assembly = assembleModelStream(
      JSON.stringify({
        object: "response",
        status: "completed",
        output: [{ type: "message", content: [{ text: "hi" }] }],
      }),
    );
    expect(assembly?.stopReason).toBe("completed");
    expect(assembly?.usage.inputTokens).toBeNull();
  });
});

describe("a non-streamed Chat Completions document", () => {
  it("reads tool calls with and without a function, and subtracts cached prompt tokens", () => {
    const assembly = assembleModelStream(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                { id: "call_1", function: { name: "ls", arguments: "{}" } },
                { id: "call_2" },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 9,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
    );
    expect(assembly?.blocks.map((block) => block.kind)).toEqual([
      "tool_use",
      "tool_use",
    ]);
    expect((assembly?.blocks[1] as ToolUseBlock).name).toBe("tool");
    expect(assembly?.usage.inputTokens).toBe(20);
    expect(assembly?.usage.cacheReadTokens).toBe(30);
    expect(assembly?.stopReason).toBe("tool_calls");
  });

  it("reads no message from an empty choice list or a choice with no message", () => {
    expect(assembleModelStream(JSON.stringify({ choices: [] }))).toBeNull();
    expect(
      assembleModelStream(JSON.stringify({ choices: [{ index: 0 }] })),
    ).toBeNull();
  });

  it("reads a message with no usage as unknown figures", () => {
    const assembly = assembleModelStream(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    );
    expect(assembly?.blocks[0]).toMatchObject({ kind: "text", text: "ok" });
    expect(assembly?.usage.inputTokens).toBeNull();
    expect(assembly?.stopReason).toBeNull();
  });
});

describe("a document that is not a model response", () => {
  it("answers null for a JSON array, a document of an unknown shape, and bytes that do not parse", () => {
    expect(assembleModelStream("[1,2,3]")).toBeNull();
    expect(assembleModelStream(JSON.stringify({ kind: "other" }))).toBeNull();
    expect(assembleModelStream("{not json")).toBeNull();
    expect(
      assembleModelStream(JSON.stringify({ type: "message", content: "x" })),
    ).toBeNull();
  });
});

describe("a streamed Chat Completions response", () => {
  it("folds text and tool-call deltas, skips malformed choices, and reads usage from the last chunk", () => {
    const assembly = assembleModelStream(
      sse([
        { choices: [null, { delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " there" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  null,
                  { id: "call_9", function: { name: "grep", arguments: "{" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "}" } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        },
      ]),
    );
    expect(assembly?.blocks.map((block) => block.kind)).toEqual([
      "text",
      "tool_use",
    ]);
    expect(assembly?.blocks[0]).toMatchObject({ text: "Hello there" });
    const tool = assembly?.blocks[1] as ToolUseBlock;
    expect(tool.name).toBe("grep");
    expect(tool.callKey).toBe("call_9");
    expect(tool.input).toEqual({});
    expect(assembly?.stopReason).toBe("stop");
    expect(assembly?.usage.inputTokens).toBe(10);
    expect(assembly?.usage.cacheReadTokens).toBe(2);
    expect(assembly?.usage.outputTokens).toBe(4);
    // The finish chunk closes every block, so nothing reads as cut off.
    expect(assembly?.partial).toBe(false);
  });

  it("marks a stream that stopped before its finish chunk as partial", () => {
    const assembly = assembleModelStream(
      sse([{ choices: [{ delta: { content: "half a sen" } }] }]),
    );
    expect(assembly?.blocks[0]).toMatchObject({ text: "half a sen" });
    expect(assembly?.partial).toBe(true);
  });
});

describe("a streamed OpenAI Responses stream", () => {
  it("ignores events that name no output index, and reads a failed response's usage", () => {
    const assembly = assembleModelStream(
      sse([
        { type: "response.created" },
        { type: "response.output_item.added", item: { type: "message" } },
        { type: "response.output_text.delta", delta: "lost" },
        { type: "response.output_text.delta", output_index: 0, delta: "kept" },
        {
          type: "response.failed",
          response: {
            status: "failed",
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
      ]),
    );
    expect(assembly?.blocks[0]).toMatchObject({ kind: "text", text: "kept" });
    expect(assembly?.stopReason).toBe("failed");
    expect(assembly?.usage.inputTokens).toBe(5);
  });
});

describe("a streamed Anthropic message", () => {
  it("ignores block events that name no index and a stop for a block it never opened", () => {
    const assembly = assembleModelStream(
      sse([
        { type: "message_start", message: { usage: { input_tokens: 3 } } },
        { type: "content_block_start", content_block: { type: "text" } },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "x" },
        },
        { type: "content_block_stop" },
        { type: "content_block_stop", index: 9 },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "kept" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: {},
          usage: {
            output_tokens: 2,
            input_tokens: 3,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 0,
          },
        },
        { type: "message_stop" },
      ]),
    );
    expect(assembly?.blocks).toHaveLength(1);
    expect(assembly?.blocks[0]).toMatchObject({ text: "kept" });
    expect(assembly?.usage).toMatchObject({
      inputTokens: 3,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      outputTokens: 2,
    });
  });
});

describe("decodeAssembly", () => {
  it("refuses a JSON value that is not an object, and one with no block list", () => {
    expect(decodeAssembly(Buffer.from("[]", "utf8"))).toBeNull();
    const assembly = assembleModelStream(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    );
    const encoded = JSON.parse(
      Buffer.from(encodeAssembly(assembly as never)).toString("utf8"),
    ) as Record<string, unknown>;
    expect(
      decodeAssembly(
        Buffer.from(JSON.stringify({ ...encoded, blocks: "none" }), "utf8"),
      ),
    ).toBeNull();
  });
});
