import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface DocumentListItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  author: string;
}

interface DocumentListResponse {
  documents: DocumentListItem[];
}

export const documentListCommand = new Command("list")
  .description("List documents in the workspace")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { workspace?: string }) => {
    try {
      const params = new URLSearchParams();
      const workspaceId = options.workspace ?? getWorkspaceId();
      if (workspaceId) params.set("workspace_id", workspaceId);
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiRequest<DocumentListResponse>(`/document/list${query}`);
      if (data.documents.length === 0) {
        console.log("No documents found.");
        return;
      }
      console.log(`Documents (${data.documents.length}):`);
      for (const doc of data.documents) {
        console.log(`  ${doc.id}  ${doc.title}  (author: ${doc.author})`);
        console.log(`    Created: ${doc.created_at}  Updated: ${doc.updated_at}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
