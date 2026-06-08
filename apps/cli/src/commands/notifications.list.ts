import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

interface Notification {
  id?: string;
  publicId?: string;
  type?: string;
  title?: string;
  readAt?: string | null;
  createdAt?: string;
}

interface NotificationsResponse {
  notifications?: Notification[];
  data?: Notification[];
}

export const notificationsListCommand = new Command("list")
  .description("List notifications")
  .option("--unread", "Show only unread notifications")
  .option("--limit <n>", "Maximum results", "20")
  .action(async (options: { unread?: boolean; limit?: string }) => {
    requireAuth();
    try {
      const qs = new URLSearchParams();
      if (options.unread) qs.set("filter", "unread");
      if (options.limit) qs.set("limit", options.limit);
      const data = await apiRequest<NotificationsResponse>(`/notifications?${qs}`);
      const items = data.notifications ?? data.data ?? [];
      if (items.length === 0) {
        console.log("No notifications.");
        return;
      }
      console.log("Notifications:");
      for (const n of items) {
        const status = n.readAt ? "  " : "• ";
        console.log(`${status}${n.publicId ?? n.id ?? "unknown"}  ${n.title ?? n.type ?? "notification"}`);
      }
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
