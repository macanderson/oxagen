import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

export const conversationDeleteCommand = new Command("delete")
  .description("Soft-delete a conversation")
  .argument("<id>", "Conversation public ID")
  .action(async (id: string) => {
    requireAuth();
    try {
      await apiRequest(`/conversations/${id}`, { method: "DELETE" });
      console.log(`✓ Conversation ${id} deleted`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
