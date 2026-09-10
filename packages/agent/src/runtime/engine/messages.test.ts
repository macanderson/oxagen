import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { CompletionMessage } from "@oxagen/stella-engine-client";
import {
  UNKNOWN_TOOL_NAME,
  UnsupportedTurnContentError,
  fromModelMessage,
  toCompletionMessages,
  toModelMessages,
  toToolOutput,
} from "./messages";

describe("toCompletionMessages", () => {
  it("opens with the system prompt and keeps history before context before the instruction", () => {
    const out = toCompletionMessages({
      system: "S",
      history: [
        { role: "user", content: "h1" },
        { role: "assistant", content: "h2" },
      ],
      context: [{ role: "user", content: "[memory]" }],
      user: { role: "user", content: "now" },
    });
    expect(out).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
      { role: "user", content: "[memory]" },
      { role: "user", content: "now" },
    ]);
  });
});

describe("fromModelMessage", () => {
  it("splits an assistant message with calls and results into two wire messages", () => {
    const message: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } },
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "t",
          output: { type: "text", value: "r" },
        },
      ],
    };
    expect(fromModelMessage(message)).toEqual([
      {
        role: "assistant",
        content: "looking",
        tool_calls: [{ call_id: "c1", name: "t", input: { a: 1 } }],
      },
      {
        role: "tool",
        tool_results: [{ call_id: "c1", output: { ok: { content: "r" } } }],
      },
    ]);
  });

  it("omits content on a tool-call-only assistant message so the wire stays byte-stable", () => {
    const [m] = fromModelMessage({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c", toolName: "t", input: {} },
      ],
    });
    expect(m).not.toHaveProperty("content");
  });

  it("carries an image as a data attachment and keeps the text", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const [m] = fromModelMessage({
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image", image: bytes, mediaType: "image/png" },
      ],
    });
    expect(m).toEqual({
      role: "user",
      content: "see",
      attachments: [
        {
          name: "attachment-1",
          media_type: "image/png",
          byte_len: 3,
          source: {
            type: "data",
            base64: Buffer.from(bytes).toString("base64"),
          },
        },
      ],
    });
  });

  it("drops reasoning parts and refuses a part it cannot carry", () => {
    const [m] = fromModelMessage({
      role: "assistant",
      content: [
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "ok" },
      ],
    });
    expect(m).toEqual({ role: "assistant", content: "ok" });
    expect(() =>
      fromModelMessage({
        role: "assistant",
        content: [
          { type: "file", data: new Uint8Array(), mediaType: "x/y" } as never,
        ],
      }),
    ).toThrow(UnsupportedTurnContentError);
  });
});

describe("toModelMessages", () => {
  it("names a tool result from the call that raised it, and unknown_tool otherwise", () => {
    const wire: CompletionMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        tool_calls: [{ call_id: "c1", name: "search", input: { q: 1 } }],
      },
      {
        role: "tool",
        tool_results: [
          { call_id: "c1", output: { ok: { content: "hit" } } },
          { call_id: "zz", output: { error: { message: "no" } } },
        ],
      },
      { role: "assistant", content: "done" },
    ];
    const out = toModelMessages(wire);
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "search",
          input: { q: 1 },
        },
      ],
    });
    expect(out[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "text", value: "hit" },
        },
        {
          type: "tool-result",
          toolCallId: "zz",
          toolName: UNKNOWN_TOOL_NAME,
          output: { type: "error-text", value: "no" },
        },
      ],
    });
    expect(out[3]).toEqual({ role: "assistant", content: "done" });
  });

  it("rebuilds a user message's attachments as image and file parts", () => {
    const out = toModelMessages([
      {
        role: "user",
        content: "see",
        attachments: [
          {
            name: "a",
            media_type: "image/png",
            byte_len: 1,
            source: { type: "data", base64: "AQ==" },
          },
          {
            name: "b",
            media_type: "video/mp4",
            byte_len: 1,
            source: { type: "data", base64: "AQ==" },
          },
        ],
      },
    ]);
    expect(out[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image", mediaType: "image/png" },
        { type: "file", mediaType: "video/mp4" },
      ],
    });
  });

  it("refuses an attachment the engine sourced from its own file system", () => {
    expect(() =>
      toModelMessages([
        {
          role: "user",
          content: "x",
          attachments: [
            {
              name: "f",
              media_type: "text/plain",
              byte_len: 1,
              source: { type: "path", path: "/tmp/f" },
            },
          ],
        },
      ]),
    ).toThrow(UnsupportedTurnContentError);
  });

  it("round-trips through both directions without loss for text and tools", () => {
    const original: ModelMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "t",
            input: { a: 1 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "t",
            output: { type: "text", value: "r" },
          },
        ],
      },
      { role: "assistant", content: "a" },
    ];
    const wire = original.flatMap(fromModelMessage);
    expect(toModelMessages(wire)).toEqual(original);
  });
});

describe("toToolOutput", () => {
  it("maps each SDK output kind onto the engine's two arms", () => {
    expect(toToolOutput({ type: "text", value: "t" })).toEqual({
      ok: { content: "t" },
    });
    expect(toToolOutput({ type: "json", value: { a: 1 } })).toEqual({
      ok: { content: '{"a":1}' },
    });
    expect(toToolOutput({ type: "error-text", value: "e" })).toEqual({
      error: { message: "e" },
    });
    expect(toToolOutput({ type: "error-json", value: { e: 1 } })).toEqual({
      error: { message: '{"e":1}' },
    });
  });
});
