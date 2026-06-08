import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AgentMcpRegisterResponse {
  mcpServerId: string;
  healthStatus: "healthy" | "degraded" | "unreachable";
  discoveredTools: string[];
}

export const agentMcpRegisterCommand = new Command("register")
  .description("Register an external MCP server with the workspace")
  .requiredOption("-n, --name <name>", "Server name")
  .requiredOption("-u, --url <url>", "Endpoint URL")
  .requiredOption("-t, --transport <type>", "Transport type: streamable-http or stdio")
  .option("--auth <strategy>", "Auth strategy: none, bearer, or header (default: none)", "none")
  .option("--auth-config <json>", "Auth config as JSON")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { name: string; url: string; transport: string; auth: string; authConfig?: string; org?: string; workspace?: string }) => {
    try {
      let authConfig: Record<string, string> | undefined;
      if (options.authConfig) {
        authConfig = JSON.parse(options.authConfig) as Record<string, string>;
      }
      const data = await apiRequest<AgentMcpRegisterResponse>("/agent/mcp/register", {
        method: "POST",
        body: JSON.stringify({
          name: options.name,
          transportType: options.transport,
          endpointUrl: options.url,
          authStrategy: options.auth,
          authConfig,
          org_id: options.org,
          workspace_id: options.workspace,
        }),
      });
      console.log(`✓ MCP server registered: ${data.mcpServerId}`);
      console.log(`  Health: ${data.healthStatus}`);
      console.log(`  Tools: ${data.discoveredTools.join(", ") || "(none)"}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
