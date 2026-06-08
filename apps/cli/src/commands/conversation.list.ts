import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

interface Conversation {
  id?: string;
  publicId?: string;
  title?: string;
  updatedAt?: string;
}

interface ConversationsResponse {
  conversations?: Conversation[];
  data?: Conversation[];
}

export const conversationListCommand = new Command("list")
  .description("List conversations")
  .option("--filter <filter>", "Filter: all | active | archived", "active")
  .option("--limit <n>", "Maximum results", "20")
  .action(async (options: { filter?: string; limit?: string }) => {
    requireAuth();
    try {
      const qs = new URLSearchParams();
      if (options.filter) qs.set("filter", options.filter);
      if (options.limit) qs.set("limit", options.limit);
      const data = await apiRequest<ConversationsResponse>(`/conversations?${qs}`);
      const convs = data.conversations ?? data.data ?? [];
      if (convs.length === 0) {
        console.log("No conversations found.");
        return;
      }
      console.log("Conversations:");
      for (const c of convs) {
        console.log(`  ${c.publicId ?? c.id ?? "unknown"}  ${c.title ?? "(untitled)"}`);
      }
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
