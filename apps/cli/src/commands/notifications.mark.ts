import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

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
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
