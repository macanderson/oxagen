import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationChat } from "@oxagen/oxagen/contracts/conversation.chat";
import { chatMessageSendHandler } from "./chat.message.send";
import { logger } from "./logger";

/**
 * conversation.chat — delegates to chatMessageSendHandler (chat.message.send).
 *
 * This is the sync/post-only surface for conversation turns; no streaming.
 * The handler maps the simplified conversation.chat input to the full
 * chat.message.send input shape, delegates, and projects the result.
 */
export const conversationChatHandler: CapabilityHandler<
  typeof conversationChat
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "conversation.chat: rejected — no authenticated user",
    );
    throw new Error("conversation.chat requires an authenticated user");
  }

  const result = await chatMessageSendHandler(
    {
      conversationId: input.conversation_id,
      parentMessageId: null,
      branchReason: null,
      content: input.message ?? "",
      contentBlocks: [],
    },
    ctx,
  );

  logger.info(
    {
      conversationId: input.conversation_id,
      userMessageId: result.userMessageId,
      orgId: ctx.orgId,
      surface: ctx.surface,
    },
    "conversation.chat: message posted",
  );

  return {
    message_id: result.userMessageId,
    created_at: new Date().toISOString(),
    author: ctx.userId,
  };
};
