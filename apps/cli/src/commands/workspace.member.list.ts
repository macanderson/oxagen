import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface WorkspaceMember {
  id: string;
  email: string;
  role: string;
  joined_at: string;
}

export const workspaceMemberListCommand = new Command("list")
  .description("List members of a workspace")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { workspace?: string }) => {
    try {
      const workspaceId = options.workspace ?? getWorkspaceId();
      const params = workspaceId ? `?workspace_id=${workspaceId}` : "";
      const data = await apiRequest<WorkspaceMember[]>(
        `/workspace/member/list${params}`,
        { method: "GET" }
      );
      if (!data.length) {
        console.log("No members found.");
        return;
      }
      console.log(`✓ ${data.length} member(s)`);
      for (const m of data) {
        const emailPart = process.stdout.isTTY ? `${m.email}  ` : "";
        console.log(`  ${emailPart}role=${m.role}  joined=${m.joined_at}  id=${m.id}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
