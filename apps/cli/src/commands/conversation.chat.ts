import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface ConversationChatResponse {
  message_id: string;
  created_at: string;
  author: string;
}

export const conversationChatCommand = new Command("chat")
  .description("Post a message to a conversation")
  .requiredOption("-c, --conversation <id>", "Conversation ID")
  .option("-m, --message <text>", "Message text to send")
  .action(async (options: { conversation: string; message?: string }) => {
    try {
      console.log(`Posting to conversation ${options.conversation}...`);
      const data = await apiRequest<ConversationChatResponse>(
        "/conversation/chat",
        {
          method: "POST",
          body: JSON.stringify({
            conversation_id: options.conversation,
            message: options.message,
          }),
        }
      );
      console.log(`✓ Message sent`);
      console.log(`  Message ID: ${data.message_id}`);
      console.log(`  Created at: ${data.created_at}`);
      console.log(`  Author:     ${data.author}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
