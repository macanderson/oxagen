import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface AgentMcpConsent {
  publicId: string;
  userId: string;
  mcpServerId: string;
  toolName: string;
  status: "granted" | "denied";
  grantedAt: string | null;
  deniedAt: string | null;
  expiresAt: string | null;
}

interface AgentMcpConsentListResponse {
  consents: AgentMcpConsent[];
}

export const agentMcpConsentListCommand = new Command("consent-list")
  .description("List external MCP tool consent grants in the active workspace")
  .option("--mine", "Return only the calling user's grants")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { mine?: boolean; org?: string; workspace?: string }) => {
    try {
      const data = await apiRequest<AgentMcpConsentListResponse>("/agent/mcp-consents", {
        method: "POST",
        body: JSON.stringify({
          mineOnly: options.mine,
          org_id: options.org ?? getOrgId(),
          workspace_id: options.workspace ?? getWorkspaceId(),
        }),
      });
      console.log(`MCP consent grants (${data.consents.length}):`);
      data.consents.forEach((consent) => {
        console.log(`  ${consent.toolName} on ${consent.mcpServerId}: ${consent.status} (${consent.publicId})`);
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
