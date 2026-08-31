/**
 * Transcript translation, both directions.
 *
 * The round-trip tests matter more than they look: Stella owns the transcript
 * while a turn runs, so every step's model call is built from a conversation
 * that has been through {@link toModelMessages}. A field lost there is lost on
 * every subsequent step of the turn, not once.
 */
import { describe, expect, test } from "vitest";
import type { ModelMessage } from "ai";
import type { CompletionMessage } from "@oxagen/stella-engine-client";
import {
  fromModelMessage,
  toCompletionMessages,
  toModelMessages,
  UNKNOWN_TOOL_NAME,
  UnsupportedTurnContentError,
} from "./message-mapping";

describe("toCompletionMessages", () => {
  test("orders system, then history, then the instruction", () => {
    const messages = toCompletionMessages({
      system: "be helpful",
      history: [{ role: "user", content: "earlier" }],
      instruction: "now do this",
    });
    expect(messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "earlier" },
      { role: "user", content: "now do this" },
    ]);
  });

  test("a turn with no history is system + instruction", () => {
    expect(
      toCompletionMessages({ system: "s", instruction: "i" }),
    ).toHaveLength(2);
  });
});

describe("fromModelMessage", () => {
  test("a tool-call-only assistant message omits content entirely", () => {
    const [assistant] = fromModelMessage({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_file",
          input: { path: "a.ts" },
        },
      ],
    });
    // Absent, not empty string: the omission is part of the prompt-cache
    // stability contract upstream.
    expect(assistant).not.toHaveProperty("content");
    expect(assistant!.tool_calls).toEqual([
      { call_id: "c1", name: "read_file", input: { path: "a.ts" } },
    ]);
  });

  test("an assistant message carrying its own tool results splits in two", () => {
    const out = fromModelMessage({
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_file",
          input: {},
        },
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_file",
          output: { type: "text", value: "contents" },
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe("assistant");
    expect(out[1]).toEqual({
      role: "tool",
      tool_results: [
        { call_id: "c1", output: { ok: { content: "contents" } } },
      ],
    });
  });

  test("an error tool result becomes the error arm", () => {
    const [, toolMessage] = fromModelMessage({
      role: "assistant",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "bash",
          output: { type: "error-text", value: "exit 1" },
        },
      ],
    });
    expect(toolMessage!.tool_results).toEqual([
      { call_id: "c1", output: { error: { message: "exit 1" } } },
    ]);
  });

  test("refuses a content part it would otherwise drop", () => {
    expect(() =>
      fromModelMessage({
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", image: "https://example.test/a.png" },
        ],
      }),
    ).toThrow(UnsupportedTurnContentError);
  });
});

describe("toModelMessages", () => {
  test("recovers each tool result's name from the call that raised it", () => {
    const engineTranscript: CompletionMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        tool_calls: [{ call_id: "c1", name: "grep", input: { q: "x" } }],
      },
      {
        role: "tool",
        tool_results: [{ call_id: "c1", output: { ok: { content: "hit" } } }],
      },
    ];
    const messages = toModelMessages(engineTranscript);
    const toolMessage = messages.at(-1) as Extract<
      ModelMessage,
      { role: "tool" }
    >;
    expect(toolMessage.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "grep",
      output: { type: "text", value: "hit" },
    });
  });

  test("an orphaned tool result is kept under a placeholder name, not dropped", () => {
    // Dropping it would leave the model looking at a tool call with no answer,
    // which reads to it as a tool that hung.
    const messages = toModelMessages([
      {
        role: "tool",
        tool_results: [{ call_id: "ghost", output: { ok: { content: "x" } } }],
      },
    ]);
    const toolMessage = messages[0] as Extract<ModelMessage, { role: "tool" }>;
    expect(toolMessage.content[0]).toMatchObject({
      toolName: UNKNOWN_TOOL_NAME,
    });
  });

  test("an assistant message with text and calls keeps both, text first", () => {
    const messages = toModelMessages([
      {
        role: "assistant",
        content: "thinking",
        tool_calls: [{ call_id: "c1", name: "bash", input: { cmd: "ls" } }],
      },
    ]);
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "thinking" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "bash",
        input: { cmd: "ls" },
      },
    ]);
  });

  test("survives a round trip through both directions", () => {
    const original: CompletionMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: "a",
        tool_calls: [{ call_id: "c1", name: "t", input: { k: 1 } }],
      },
      {
        role: "tool",
        tool_results: [{ call_id: "c1", output: { ok: { content: "r" } } }],
      },
    ];
    const roundTripped = toModelMessages(original).flatMap(fromModelMessage);
    expect(roundTripped).toEqual(original);
  });
});
