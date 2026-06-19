import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface AgentMcpConsentResolveResponse {
  approvalId: string;
  resolution: "granted" | "denied" | "expired";
}

export const agentMcpConsentResolveCommand = new Command("consent-resolve")
  .description("Grant or deny first-use consent for an external MCP tool")
  .requiredOption("-a, --approval <id>", "Pending consent request (approval) ID")
  .requiredOption("-d, --decision <decision>", "Decision (granted|denied)")
  .option("--grant-all-tools", "Pre-grant every tool on the server (only with granted)")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { approval: string; decision: string; grantAllTools?: boolean; org?: string; workspace?: string }) => {
    try {
      if (!["granted", "denied"].includes(options.decision)) {
        throw new Error("--decision must be 'granted' or 'denied'");
      }
      const data = await apiRequest<AgentMcpConsentResolveResponse>("/agent/mcp-consents/resolve", {
        method: "POST",
        body: JSON.stringify({
          approvalId: options.approval,
          decision: options.decision,
          grantAllTools: options.grantAllTools,
          org_id: options.org ?? getOrgId(),
          workspace_id: options.workspace ?? getWorkspaceId(),
        }),
      });
      console.log(`✓ Consent ${data.approvalId} resolved: ${data.resolution}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
