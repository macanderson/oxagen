import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface ConversationPurgeResponse {
  deleted: number;
}

export const conversationPurgeCommand = new Command("purge")
  .description("Permanently delete every archived conversation you own in this workspace")
  .requiredOption("-w, --workspace <id>", "Workspace ID")
  .option("-o, --org <id>", "Organization ID")
  .option("--yes", "Skip confirmation prompt")
  .action(async (options: { workspace: string; org?: string; yes?: boolean }) => {
    if (!options.yes) {
      console.error("This will permanently delete all your archived conversations. Pass --yes to confirm.");
      process.exit(1);
    }
    try {
      const data = await apiRequest<ConversationPurgeResponse>("/conversation/purge", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: options.workspace,
          org_id: options.org,
        }),
      });
      console.log(`✓ Purged ${data.deleted} archived conversation(s)`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
