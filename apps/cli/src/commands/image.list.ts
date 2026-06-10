import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface ImageListItem {
  id: string;
  url: string;
  created_at: string;
  prompt: string;
}

interface ImageListResponse {
  images: ImageListItem[];
}

export const imageListCommand = new Command("list")
  .description("List images in the workspace")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { workspace?: string }) => {
    try {
      const params = new URLSearchParams();
      const workspaceId = options.workspace ?? getWorkspaceId();
      if (workspaceId) params.set("workspace_id", workspaceId);
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiRequest<ImageListResponse>(`/image/list${query}`);
      if (data.images.length === 0) {
        console.log("No images found.");
        return;
      }
      console.log(`Images (${data.images.length}):`);
      for (const image of data.images) {
        console.log(`  ${image.id}  ${image.prompt ?? "(no prompt)"}  ${image.created_at}`);
        console.log(`    URL: ${image.url}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
