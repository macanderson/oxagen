import { z } from "zod";
import { registerCapability } from "../registry";

export const agentMcpAuthorizeComplete = registerCapability({
  name: "authorize_mcp_server",
  domain: "agent",
  description:
    "Finish OAuth authorization for an MCP server: exchange the code the authorization server returned, store the tokens encrypted, and list the server's tools",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    state: z.string().min(1).max(200),
    code: z.string().min(1).max(4000),
    /** The same callback `start_mcp_authorization` was given. */
    redirectUrl: z.string().url(),
  }),
  output: z.object({
    mcpServerId: z.string(),
    name: z.string(),
    healthStatus: z.enum(["healthy", "degraded", "unreachable"]),
    discoveredTools: z.array(z.string()),
  }),
});

export type AgentMcpAuthorizeCompleteInput = z.output<
  typeof agentMcpAuthorizeComplete.input
>;
export type AgentMcpAuthorizeCompleteOutput = z.output<
  typeof agentMcpAuthorizeComplete.output
>;
