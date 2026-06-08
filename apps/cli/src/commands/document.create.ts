import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface DocumentCreateResponse {
  document_id: string;
  title: string;
  created_at: string;
  workspace_id: string;
}

export const documentCreateCommand = new Command("create")
  .description("Create a new document in the workspace")
  .requiredOption("-t, --title <title>", "Document title")
  .option("-c, --content <text>", "Initial document content")
  .action(async (options: { title: string; content?: string }) => {
    try {
      console.log(`Creating document "${options.title}"...`);
      const data = await apiRequest<DocumentCreateResponse>(
        "/document/create",
        {
          method: "POST",
          body: JSON.stringify({
            title: options.title,
            content: options.content,
          }),
        }
      );
      console.log(`✓ Document created`);
      console.log(`  ID:           ${data.document_id}`);
      console.log(`  Title:        ${data.title}`);
      console.log(`  Workspace ID: ${data.workspace_id}`);
      console.log(`  Created at:   ${data.created_at}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
