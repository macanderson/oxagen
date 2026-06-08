import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationChat } from "@oxagen/oxagen/contracts/conversation.chat";

export const conversationChatHandler: CapabilityHandler<typeof conversationChat> = async (
  input,
  ctx,
) => {
  console.log(
    `[stub] conversation.chat conversation_id=${input.conversation_id} user=${ctx.userId}`,
  );
  return {
    message_id: `msg_stub_${Date.now()}`,
    created_at: new Date().toISOString(),
    author: ctx.userId ?? "unknown",
  };
};
