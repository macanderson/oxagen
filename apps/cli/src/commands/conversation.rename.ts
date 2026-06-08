import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

export const conversationRenameCommand = new Command("rename")
  .description("Rename a conversation")
  .argument("<id>", "Conversation public ID")
  .argument("<title>", "New title")
  .action(async (id: string, title: string) => {
    requireAuth();
    try {
      await apiRequest(`/conversations/${id}/rename`, {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      console.log(`✓ Conversation ${id} renamed to "${title}"`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
