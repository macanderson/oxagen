import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentMcpList = registerCapability({
  name: "agent.mcp.list",
  domain: "agent",
  description: "List registered external MCP servers in the active workspace with their current health",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  input: z.object({}),
  output: z.object({
    servers: z.array(
      z.object({
        publicId: z.string(),
        name: z.string(),
        transportType: z.enum(["streamable-http", "stdio"]),
        endpointUrl: z.string(),
        healthStatus: z.enum(["healthy", "degraded", "unreachable"]),
        lastHealthcheckAt: z.string().nullable(),
        toolCount: z.number().int().nonnegative(),
      }),
    ),
  }),
});

export type AgentMcpListInput = z.output<typeof agentMcpList.input>;
export type AgentMcpListOutput = z.output<typeof agentMcpList.output>;
