import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

export const conversationArchiveCommand = new Command("archive")
  .description("Archive a conversation")
  .argument("<id>", "Conversation public ID")
  .option("--unarchive", "Reverse the archive")
  .action(async (id: string, options: { unarchive?: boolean }) => {
    requireAuth();
    try {
      await apiRequest(`/conversations/${id}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived: !options.unarchive }),
      });
      const action = options.unarchive ? "unarchived" : "archived";
      console.log(`✓ Conversation ${id} ${action}`);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
