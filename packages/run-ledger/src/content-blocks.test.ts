import { describe, expect, it } from "vitest";
import {
  assembleModelStream,
  decodeAssembly,
  encodeAssembly,
  looksLikeModelStream,
  MESSAGE_ASSEMBLY_VERSION,
  type ToolUseBlock,
} from "./content-blocks";

function sse(...events: Array<[string, unknown]>): string {
  return events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const START: [string, unknown] = [
  "message_start",
  {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 40,
        output_tokens: 1,
      },
    },
  },
];

function textDeltas(
  index: number,
  chunks: readonly string[],
): Array<[string, unknown]> {
  return chunks.map((text) => [
    "content_block_delta",
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  ]);
}

describe("assembleModelStream", () => {
  it("reads terminal reasoning and refusal parts while ignoring unsupported output", () => {
    const response = {
      status: "completed",
      usage: { input_tokens: 7 },
      output: [
        { type: "reasoning", summary: [{ text: "Check assumptions." }] },
        {
          type: "message",
          content: [{ refusal: "Cannot comply." }, { type: "audio" }, null],
        },
        { type: "web_search_call" },
        null,
      ],
    };
    const assembly = assembleModelStream(
      sse(["response.completed", { type: "response.completed", response }]),
    );
    expect(assembly?.blocks).toMatchObject([
      { kind: "thinking", text: "Check assumptions.", partial: false },
      { kind: "text", text: "Cannot comply.", partial: false },
    ]);
    expect(assembly?.usage.inputTokens).toBe(7);
    expect(assembly?.usage.cacheReadTokens).toBeNull();
  });

  it("retains tool identity when a done item omits fields", () => {
    const assembly = assembleModelStream(
      sse(
        [
          "response.output_item.added",
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              name: "Read",
              call_id: "call1",
              arguments: "{}",
            },
          },
        ],
        [
          "response.output_item.done",
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "function_call" },
          },
        ],
        [
          "response.incomplete",
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              output: [{ type: "function_call", status: "completed" }],
            },
          },
        ],
      ),
    );
    expect(assembly?.blocks[0]).toMatchObject({
      kind: "tool_use",
      name: "Read",
      callKey: "call1",
      input: {},
      partial: false,
    });
    expect(assembly?.partial).toBe(true);
  });

  it("ignores unindexed and malformed events without losing adjacent text", () => {
    const wire = sse(
      ["response.in_progress", { type: "response.in_progress" }],
      ["response.output_item.done", { type: "response.output_item.done" }],
      [
        "response.output_item.done",
        { type: "response.output_item.done", output_index: 4, item: null },
      ],
      [
        "response.output_text.delta",
        { type: "response.output_text.delta", delta: "unindexed" },
      ],
      [
        "response.output_text.delta",
        { type: "response.output_text.delta", output_index: 0, delta: "kept" },
      ],
      [
        "response.output_text.delta",
        { type: "response.output_text.delta", output_index: 0 },
      ],
      [
        "response.output_text.done",
        { type: "response.output_text.done", output_index: 0 },
      ],
      ["response.completed", { type: "response.completed" }],
    );
    expect(assembleModelStream(wire)?.blocks).toMatchObject([
      { text: "kept", partial: false },
    ]);
    expect(assembleModelStream('{"request":')).toBeNull();
    expect(
      assembleModelStream(JSON.stringify({ request: {}, response: wire })),
    ).toBeNull();
  });

  it("records tool result summaries and final Anthropic usage updates", () => {
    const wire = sse(
      ["message_start", { type: "message_start", message: {} }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_result",
            tool_use_id: "c1",
            text: "x".repeat(200) + "\nsecond line",
          },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_result", text: "short" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 4,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 6,
            output_tokens: 3,
          },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    );
    const assembly = assembleModelStream(wire);
    expect(assembly?.blocks).toMatchObject([
      {
        kind: "tool_result",
        forId: "c1",
        summary: "x".repeat(179) + "…",
        partial: false,
      },
      { kind: "tool_result", forId: "b1", summary: "short", partial: false },
    ]);
    expect(assembly?.usage).toEqual({
      inputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
      outputTokens: 3,
    });
    expect(assembly?.blocks.reduce((sum, block) => sum + block.tokens, 0)).toBe(
      3,
    );
  });

  it("unwraps a retained exchange after a long request", () => {
    const response = sse(START, ...textDeltas(0, ["answer"]), [
      "message_stop",
      { type: "message_stop" },
    ]);
    const wire = JSON.stringify({ request: "x".repeat(8000), response });
    expect(looksLikeModelStream(wire)).toBe(true);
    expect(assembleModelStream(wire)?.blocks[0]).toMatchObject({
      kind: "text",
      text: "answer",
    });
    expect(assembleModelStream(wire)?.wire.bytes).toBe(Buffer.byteLength(wire));
  });

  it("folds Responses text, reasoning, tools, completion, and cached usage", () => {
    const events = [
      { type: "response.created", response: {} },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: {
          type: "function_call",
          name: "read",
          call_id: "call1",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: '"a"}',
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 2,
        arguments: '{"path":"a"}',
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        content_index: 0,
        delta: "Hello",
      },
      {
        type: "response.output_text.done",
        output_index: 1,
        content_index: 0,
        text: "Hello",
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "Think",
      },
      {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        text: "Think",
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 60 },
            output_tokens: 20,
          },
        },
      },
    ];
    const assembly = assembleModelStream(
      sse(...events.map((event): [string, unknown] => [event.type, event])),
    );
    expect(assembly?.blocks).toMatchObject([
      { kind: "thinking", text: "Think", partial: false },
      { kind: "text", text: "Hello", partial: false },
      {
        kind: "tool_use",
        name: "read",
        callKey: "call1",
        input: { path: "a" },
        partial: false,
      },
    ]);
    expect(assembly?.usage).toEqual({
      inputTokens: 40,
      cacheReadTokens: 60,
      cacheWriteTokens: null,
      outputTokens: 20,
    });
    expect(assembly?.stopReason).toBe("completed");
    expect(assembly?.partial).toBe(false);
  });

  it("recovers completed output snapshots without duplicating deltas", () => {
    const assembly = assembleModelStream(
      sse(
        [
          "response.output_text.delta",
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "Hi",
          },
        ],
        [
          "response.completed",
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "Hi there" }],
                },
                {
                  type: "function_call",
                  name: "read",
                  call_id: "c",
                  arguments: "{}",
                },
              ],
            },
          },
        ],
      ),
    );
    expect(assembly?.blocks).toMatchObject([
      { text: "Hi there", partial: false },
      { name: "read", input: {}, partial: false },
    ]);
  });

  it("retains a refusal when the response fails", () => {
    const assembly = assembleModelStream(
      sse(
        [
          "response.refusal.delta",
          {
            type: "response.refusal.delta",
            output_index: 0,
            content_index: 0,
            delta: "Cannot",
          },
        ],
        [
          "response.refusal.done",
          {
            type: "response.refusal.done",
            output_index: 0,
            content_index: 0,
            refusal: "Cannot answer.",
          },
        ],
        [
          "response.failed",
          { type: "response.failed", response: { status: "failed" } },
        ],
      ),
    );
    expect(assembly?.blocks[0]).toMatchObject({
      kind: "text",
      text: "Cannot answer.",
      partial: false,
    });
    expect(assembly?.partial).toBe(true);
    expect(assembly?.stopReason).toBe("failed");
  });

  it("keeps interrupted Responses calls partial", () => {
    const assembly = assembleModelStream(
      sse(
        [
          "response.function_call_arguments.delta",
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: '{"path":',
          },
        ],
        [
          "response.incomplete",
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        ],
      ),
    );
    expect(assembly?.blocks[0]).toMatchObject({
      inputRaw: true,
      partial: true,
    });
    expect(assembly?.partial).toBe(true);
    expect(assembly?.stopReason).toBe("max_output_tokens");
  });

  it("folds text deltas into one block and keeps the reported usage split", () => {
    const wire = sse(
      START,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
      ],
      ...textDeltas(0, ["I'll write ", "the filing ", "plan."]),
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 24 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    );

    const assembly = assembleModelStream(wire, {
      ttftMs: 310,
      durationMs: 4200,
    });

    expect(assembly).not.toBeNull();
    expect(assembly?.blocks).toHaveLength(1);
    expect(assembly?.blocks[0]).toMatchObject({
      kind: "text",
      id: "b0",
      text: "I'll write the filing plan.",
      partial: false,
    });
    expect(assembly?.stopReason).toBe("end_turn");
    expect(assembly?.ttftMs).toBe(310);
    expect(assembly?.durationMs).toBe(4200);
    expect(assembly?.usage).toEqual({
      inputTokens: 12,
      cacheReadTokens: 900,
      cacheWriteTokens: 40,
      outputTokens: 24,
    });
    expect(assembly?.partial).toBe(false);
    expect(assembly?.wire.events).toBe(8);
    expect(assembly?.wire.bytes).toBe(Buffer.byteLength(wire, "utf8"));
  });

  it("folds by index, not by arrival, when two blocks interleave", () => {
    const wire = sse(
      START,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text" },
        },
      ],
      ...textDeltas(1, ["second"]),
      ...textDeltas(0, ["first"]),
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_stop", { type: "message_stop" }],
    );

    const blocks = assembleModelStream(wire)?.blocks ?? [];

    expect(blocks.map((b) => b.id)).toEqual(["b0", "b1"]);
    expect(blocks.map((b) => (b.kind === "text" ? b.text : ""))).toEqual([
      "first",
      "second",
    ]);
  });

  it("parses a tool call's input_json_delta fragments at content_block_stop", () => {
    const wire = sse(
      START,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "Write" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '{"file_path":"/a/',
          },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: 'b.ts","content":"x"}',
          },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_stop", { type: "message_stop" }],
    );

    const block = assembleModelStream(wire)?.blocks[0] as ToolUseBlock;

    expect(block.kind).toBe("tool_use");
    expect(block.name).toBe("Write");
    expect(block.callKey).toBe("toolu_1");
    expect(block.input).toEqual({ file_path: "/a/b.ts", content: "x" });
    expect(block.inputRaw).toBe(false);
    expect(block.partial).toBe(false);
  });

  it("keeps a tool call's raw fragments and marks it partial when they do not parse", () => {
    const wire = sse(
      START,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_2", name: "Bash" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls -' },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_stop", { type: "message_stop" }],
    );

    const block = assembleModelStream(wire)?.blocks[0] as ToolUseBlock;

    expect(block.input).toBe('{"command":"ls -');
    expect(block.inputRaw).toBe(true);
    expect(block.partial).toBe(true);
  });

  it("keeps a block the stream was cut off inside, and says the message is partial", () => {
    const wire = sse(
      START,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
      ],
      ...textDeltas(0, ["half a senten"]),
    );

    const assembly = assembleModelStream(wire);

    expect(assembly?.blocks).toHaveLength(1);
    expect(assembly?.blocks[0]).toMatchObject({
      kind: "text",
      text: "half a senten",
      partial: true,
    });
    expect(assembly?.partial).toBe(true);
    expect(assembly?.stopReason).toBeNull();
  });

  it("survives a data line the recorder cut mid-JSON", () => {
    const wire = `${sse(
      START,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
      ],
      ...textDeltas(0, ["kept"]),
    )}event: content_block_delta\ndata: {"type":"content_bl`;

    const assembly = assembleModelStream(wire);

    expect(assembly?.blocks[0]).toMatchObject({ kind: "text", text: "kept" });
    expect(assembly?.partial).toBe(true);
  });

  it("apportions the reported output tokens across blocks so the shares sum to it", () => {
    const wire = sse(
      START,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "x".repeat(300) },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text" },
        },
      ],
      ...textDeltas(1, ["y".repeat(100)]),
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 100 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    );

    const blocks = assembleModelStream(wire)?.blocks ?? [];

    expect(blocks.map((b) => b.tokens)).toEqual([75, 25]);
    expect(blocks.reduce((sum, b) => sum + b.tokens, 0)).toBe(100);
    expect(blocks[0]?.kind).toBe("thinking");
  });

  it("answers null for bytes that are not a model stream", () => {
    expect(assembleModelStream("a prompt a person typed")).toBeNull();
    expect(assembleModelStream('{"tool":"Write","input":{}}')).toBeNull();
    expect(looksLikeModelStream("plain text")).toBe(false);
  });

  it("answers null for SSE framing that carries no message", () => {
    expect(
      assembleModelStream('event: ping\ndata: {"type":"ping"}\n\n'),
    ).toBeNull();
  });

  it("round-trips through the stored encoding and refuses another version", () => {
    const wire = sse(START, ...textDeltas(0, ["hi"]), [
      "message_stop",
      { type: "message_stop" },
    ]);
    const assembly = assembleModelStream(wire);
    expect(assembly).not.toBeNull();

    expect(decodeAssembly(encodeAssembly(assembly as never))).toEqual(assembly);
    expect(
      decodeAssembly(
        Buffer.from(
          JSON.stringify({ version: MESSAGE_ASSEMBLY_VERSION + 1, blocks: [] }),
          "utf8",
        ),
      ),
    ).toBeNull();
    expect(decodeAssembly(Buffer.from("not json", "utf8"))).toBeNull();
  });

  it("leaves the recorded bytes alone: the fold reads, it never rewrites", () => {
    const wire = sse(START, ...textDeltas(0, ["a"]), [
      "message_stop",
      { type: "message_stop" },
    ]);
    const before = Buffer.from(wire, "utf8").toString("base64");

    assembleModelStream(wire);

    expect(Buffer.from(wire, "utf8").toString("base64")).toBe(before);
  });

  it("unwraps a lone response, when the request half never shipped (P0-1)", () => {
    const response = sse(START, ...textDeltas(0, ["answer"]), [
      "message_stop",
      { type: "message_stop" },
    ]);
    // JCS drops a member with no bytes: a request over the cap ships
    // `{"response":...}` alone, with no `request` key at all.
    const wire = JSON.stringify({ response });
    expect(looksLikeModelStream(wire)).toBe(true);
    expect(assembleModelStream(wire)?.blocks[0]).toMatchObject({
      kind: "text",
      text: "answer",
    });
  });

  it("leaves a malformed exchange alone: a `request` that is present but not a string", () => {
    const response = sse(START, ...textDeltas(0, ["answer"]), [
      "message_stop",
      { type: "message_stop" },
    ]);
    const wire = JSON.stringify({ request: {}, response });
    // `looksLikeModelStream` matches on the raw text, which still contains
    // the SSE event names verbatim inside the un-unwrapped JSON string; the
    // fold itself is what refuses this shape, finding no real SSE lines once
    // `responseWire` declines to unwrap a non-string `request`.
    expect(looksLikeModelStream(wire)).toBe(true);
    expect(assembleModelStream(wire)).toBeNull();
  });

  describe("a response that was never streamed (P2-10)", () => {
    it("folds a non-streamed Anthropic Messages document", () => {
      const wire = JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Reading the file." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file: "a.ts" },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 3,
        },
      });
      expect(looksLikeModelStream(wire)).toBe(false);
      const assembly = assembleModelStream(wire);
      expect(assembly?.stopReason).toBe("tool_use");
      expect(assembly?.partial).toBe(false);
      expect(assembly?.blocks).toMatchObject([
        { kind: "text", text: "Reading the file." },
        {
          kind: "tool_use",
          name: "Read",
          input: { file: "a.ts" },
          inputRaw: false,
          callKey: "toolu_1",
        },
      ]);
      expect(assembly?.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
      });
    });

    it("folds a non-streamed OpenAI Responses document", () => {
      const wire = JSON.stringify({
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Plan first." }],
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "Done." }],
          },
          {
            type: "function_call",
            name: "Write",
            call_id: "call_1",
            arguments: '{"path":"b.ts"}',
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          input_tokens_details: { cached_tokens: 4 },
        },
      });
      expect(looksLikeModelStream(wire)).toBe(false);
      const assembly = assembleModelStream(wire);
      expect(assembly?.stopReason).toBe("completed");
      expect(assembly?.blocks).toMatchObject([
        { kind: "thinking", text: "Plan first." },
        { kind: "text", text: "Done." },
        {
          kind: "tool_use",
          name: "Write",
          input: { path: "b.ts" },
          callKey: "call_1",
        },
      ]);
      expect(assembly?.usage).toEqual({
        inputTokens: 8,
        outputTokens: 6,
        cacheReadTokens: 4,
        cacheWriteTokens: null,
      });
    });

    it("folds a non-streamed OpenAI Chat Completions document, text and tool calls", () => {
      const wire = JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Reading first.",
              tool_calls: [
                {
                  id: "call_2",
                  type: "function",
                  function: { name: "Read", arguments: '{"file":"c.ts"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 1 },
        },
      });
      expect(looksLikeModelStream(wire)).toBe(false);
      const assembly = assembleModelStream(wire);
      expect(assembly?.stopReason).toBe("tool_calls");
      expect(assembly?.blocks).toMatchObject([
        { kind: "text", text: "Reading first." },
        {
          kind: "tool_use",
          name: "Read",
          input: { file: "c.ts" },
          callKey: "call_2",
        },
      ]);
      expect(assembly?.usage).toEqual({
        inputTokens: 8,
        outputTokens: 4,
        cacheReadTokens: 1,
        cacheWriteTokens: null,
      });
    });

    it("folds a streamed OpenAI Chat Completions response, text and tool call deltas", () => {
      const wire = [
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({
          id: "c1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_3",
                    function: { name: "Read", arguments: '{"fi' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "c1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'le":"d.ts"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      expect(looksLikeModelStream(wire)).toBe(true);
      const assembly = assembleModelStream(wire);
      expect(assembly?.stopReason).toBe("tool_calls");
      expect(assembly?.blocks).toMatchObject([
        { kind: "text", text: "Hello", partial: false },
        {
          kind: "tool_use",
          name: "Read",
          input: { file: "d.ts" },
          callKey: "call_3",
          partial: false,
        },
      ]);
      expect(assembly?.usage.inputTokens).toBe(5);
      expect(assembly?.usage.outputTokens).toBe(2);
    });

    it("answers null for a plain JSON body that matches none of the three shapes", () => {
      expect(
        assembleModelStream(JSON.stringify({ hello: "world" })),
      ).toBeNull();
      expect(assembleModelStream("not json at all")).toBeNull();
      expect(assembleModelStream("")).toBeNull();
    });
  });
});
