import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface BrandkitApplyResponse {
  stub: true;
  applied: false;
  brandKitId: string;
  targetFileId: string;
}

export const brandkitApplyCommand = new Command("apply")
  .description("Apply a workspace brand kit to an existing cloud file")
  .requiredOption("-b, --brand-kit <id>", "Brand kit ID to apply")
  .requiredOption("-f, --file <id>", "Target cloud file ID")
  .requiredOption("-w, --workspace <id>", "Workspace ID")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { brandKit: string; file: string; workspace: string; org?: string }) => {
    try {
      const data = await apiRequest<BrandkitApplyResponse>("/brandkit/apply", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: options.workspace ?? getWorkspaceId(),
          brandKitId: options.brandKit,
          targetFileId: options.file,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(`Brand kit apply submitted (stub — backing not yet wired)`);
      console.log(`  Brand Kit: ${data.brandKitId}`);
      console.log(`  File:      ${data.targetFileId}`);
      console.log(`  Applied:   ${data.applied}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
