import { describe, expect, it } from "vitest";
import { conversationChat } from "./conversation.chat";
import { getCapability } from "../registry";

describe("conversation.chat capability", () => {
  // ── input: conversation_id required ──────────────────────────────────────

  it("parses minimal input with only conversation_id", () => {
    const parsed = conversationChat.input.parse({
      conversation_id: "cnv_abc123",
    });
    expect(parsed.conversation_id).toBe("cnv_abc123");
  });

  it("rejects missing conversation_id", () => {
    expect(() => conversationChat.input.parse({})).toThrow();
  });

  it("rejects non-string conversation_id", () => {
    expect(() =>
      conversationChat.input.parse({ conversation_id: 42 }),
    ).toThrow();
  });

  // ── input: message optional ───────────────────────────────────────────────

  it("defaults message to undefined when omitted", () => {
    const parsed = conversationChat.input.parse({
      conversation_id: "cnv_abc123",
    });
    expect(parsed.message).toBeUndefined();
  });

  it("accepts a non-empty message string", () => {
    const parsed = conversationChat.input.parse({
      conversation_id: "cnv_abc123",
      message: "Hello, world!",
    });
    expect(parsed.message).toBe("Hello, world!");
  });

  it("accepts an empty message string (optional field, no min constraint)", () => {
    const parsed = conversationChat.input.parse({
      conversation_id: "cnv_abc123",
      message: "",
    });
    expect(parsed.message).toBe("");
  });

  it("rejects non-string message", () => {
    expect(() =>
      conversationChat.input.parse({
        conversation_id: "cnv_abc123",
        message: 123,
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = conversationChat.output.parse({
      message_id: "msg_xyz789",
      created_at: "2024-01-01T00:00:00.000Z",
      author: "user",
    });
    expect(parsed.message_id).toBe("msg_xyz789");
    expect(parsed.created_at).toBe("2024-01-01T00:00:00.000Z");
    expect(parsed.author).toBe("user");
  });

  it("accepts any string for author", () => {
    const parsed = conversationChat.output.parse({
      message_id: "msg_001",
      created_at: "2024-06-01T12:00:00.000Z",
      author: "assistant",
    });
    expect(parsed.author).toBe("assistant");
  });

  it("rejects output missing message_id", () => {
    expect(() =>
      conversationChat.output.parse({
        created_at: "2024-01-01T00:00:00.000Z",
        author: "user",
      }),
    ).toThrow();
  });

  it("rejects output missing created_at", () => {
    expect(() =>
      conversationChat.output.parse({
        message_id: "msg_001",
        author: "user",
      }),
    ).toThrow();
  });

  it("rejects output missing author", () => {
    expect(() =>
      conversationChat.output.parse({
        message_id: "msg_001",
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with non-string message_id", () => {
    expect(() =>
      conversationChat.output.parse({
        message_id: 42,
        created_at: "2024-01-01T00:00:00.000Z",
        author: "user",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("conversation.chat")).toBe(conversationChat);
  });
});
