import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  chatMessageSend: vi.fn(),
}));

const SEND_RESULT = {
  conversationId: "conv_123",
  userMessageId: "msg_user_abc",
  assistantMessageId: "msg_asst_abc",
  activeLeafMessageId: "msg_asst_abc",
};

mocks.chatMessageSend.mockResolvedValue(SEND_RESULT);

vi.mock("./chat.message.send", () => ({
  chatMessageSendHandler: mocks.chatMessageSend,
}));

import { conversationChatHandler } from "./conversation.chat";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("conversationChatHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatMessageSend.mockResolvedValue(SEND_RESULT);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      conversationChatHandler(
        { conversation_id: "conv_123", message: "hello" },
        anonCtx,
      ),
    ).rejects.toThrow("conversation.chat requires an authenticated user");
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns message_id from chatMessageSendHandler.userMessageId", async () => {
    const result = await conversationChatHandler(
      { conversation_id: "conv_123", message: "hello world" },
      CTX,
    );
    expect(result.message_id).toBe("msg_user_abc");
    expect(result.author).toBe("u_1");
    expect(typeof result.created_at).toBe("string");
    // created_at is a valid ISO date
    expect(() => new Date(result.created_at)).not.toThrow();
  });

  // ── delegation ────────────────────────────────────────────────────────────

  it("delegates to chatMessageSendHandler with mapped input", async () => {
    await conversationChatHandler(
      { conversation_id: "conv_abc", message: "test message" },
      CTX,
    );
    expect(mocks.chatMessageSend).toHaveBeenCalledTimes(1);
    expect(mocks.chatMessageSend).toHaveBeenCalledWith(
      {
        conversationId: "conv_abc",
        parentMessageId: null,
        branchReason: null,
        content: "test message",
        contentBlocks: [],
      },
      CTX,
    );
  });

  it("maps undefined message to empty string in content", async () => {
    await conversationChatHandler({ conversation_id: "conv_abc" }, CTX);
    expect(mocks.chatMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: "" }),
      CTX,
    );
  });

  it("author is always ctx.userId", async () => {
    const result = await conversationChatHandler(
      { conversation_id: "conv_123", message: "hi" },
      { ...CTX, userId: "u_special" },
    );
    expect(result.author).toBe("u_special");
  });

  // ── error propagation ─────────────────────────────────────────────────────

  it("propagates errors from chatMessageSendHandler", async () => {
    mocks.chatMessageSend.mockRejectedValueOnce(new Error("DB error"));
    await expect(
      conversationChatHandler(
        { conversation_id: "conv_123", message: "hello" },
        CTX,
      ),
    ).rejects.toThrow("DB error");
  });
});
