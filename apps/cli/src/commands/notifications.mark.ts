import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

export const notificationsMarkCommand = new Command("mark")
  .description("Mark a notification as read or unread")
  .argument("<id>", "Notification public ID")
  .option("--unread", "Mark as unread instead")
  .action(async (id: string, options: { unread?: boolean }) => {
    requireAuth();
    try {
      await apiRequest(`/notifications/${id}/mark`, {
        method: "POST",
        body: JSON.stringify({ read: !options.unread }),
      });
      const state = options.unread ? "unread" : "read";
      console.log(`✓ Notification ${id} marked as ${state}`);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
