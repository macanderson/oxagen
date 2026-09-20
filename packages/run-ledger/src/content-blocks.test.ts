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

function textDeltas(index: number, chunks: readonly string[]): Array<[string, unknown]> {
  return chunks.map((text) => [
    "content_block_delta",
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  ]);
}

describe("assembleModelStream", () => {
  it("folds text deltas into one block and keeps the reported usage split", () => {
    const wire = sse(
      START,
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
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

    const assembly = assembleModelStream(wire, { ttftMs: 310, durationMs: 4200 });

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
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
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
          delta: { type: "input_json_delta", partial_json: '{"file_path":"/a/' },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'b.ts","content":"x"}' },
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
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
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
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
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
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
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
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
      ],
      ...textDeltas(1, ["y".repeat(100)]),
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } },
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
    expect(assembleModelStream("event: ping\ndata: {\"type\":\"ping\"}\n\n")).toBeNull();
  });

  it("round-trips through the stored encoding and refuses another version", () => {
    const wire = sse(START, ...textDeltas(0, ["hi"]), ["message_stop", { type: "message_stop" }]);
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
    const wire = sse(START, ...textDeltas(0, ["a"]), ["message_stop", { type: "message_stop" }]);
    const before = Buffer.from(wire, "utf8").toString("base64");

    assembleModelStream(wire);

    expect(Buffer.from(wire, "utf8").toString("base64")).toBe(before);
  });
});
