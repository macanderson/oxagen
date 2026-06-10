import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface ArchiveResponse {
  id: string;
  name: string;
  status: string;
}

export const archiveCreateCommand = new Command("create")
  .description("Create an archive from conversation history")
  .requiredOption("-c, --conversation <id>", "Conversation ID")
  .option("-n, --name <name>", "Archive name")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { conversation: string; name?: string; workspace?: string }) => {
    try {
      console.log(`Creating archive from conversation ${options.conversation}...`);
      const data = await apiRequest<ArchiveResponse>("/archive/create", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: options.conversation,
          name: options.name,
          workspace_id: options.workspace ?? getWorkspaceId(),
        }),
      });
      console.log(`✓ Archive created`);
      console.log(`  Name: ${data.name}`);
      console.log(`  Status: ${data.status}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
