import { z } from "zod";
import { registerCapability } from "../registry";

// Both value sets mirror the CHECK constraints on mcp.mcp_servers
// (packages/database/src/schema/mcp.ts). Plugin-installed servers are
// written with transport 'sse' and health 'unknown', so the list output has
// to admit every value the table can hold. The handler narrows each row
// through these same schemas.
export const mcpServerTransportType = z.enum([
  "streamable-http",
  "sse",
  "stdio",
]);
export const mcpServerHealthStatus = z.enum([
  "healthy",
  "degraded",
  "unreachable",
  "unknown",
]);

export const agentMcpList = registerCapability({
  name: "list_mcp_servers",
  domain: "agent",
  description:
    "List registered external MCP servers in the active workspace with their current health",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({
    servers: z.array(
      z.object({
        publicId: z.string(),
        name: z.string(),
        transportType: mcpServerTransportType,
        endpointUrl: z.string(),
        healthStatus: mcpServerHealthStatus,
        lastHealthcheckAt: z.string().nullable(),
        toolCount: z.number().int().nonnegative(),
      }),
    ),
  }),
});

export type AgentMcpListInput = z.output<typeof agentMcpList.input>;
export type AgentMcpListOutput = z.output<typeof agentMcpList.output>;
