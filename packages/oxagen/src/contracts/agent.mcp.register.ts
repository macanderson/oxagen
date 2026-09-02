import { z } from "zod";
import { registerCapability } from "../registry";

export const agentMcpRegister = registerCapability({
  name: "register_mcp_server",
  domain: "agent",
  description:
    "Register an external MCP server with the workspace; its tools become available to the agent after health check",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    name: z.string().min(1).max(120),
    transportType: z.enum(["streamable-http", "stdio"]),
    endpointUrl: z.string().url(),
    authStrategy: z.enum(["none", "bearer", "header"]).default("none"),
    authConfig: z.record(z.string()).optional(),
  }),
  output: z.object({
    mcpServerId: z.string(),
    healthStatus: z.enum(["healthy", "degraded", "unreachable"]),
    discoveredTools: z.array(z.string()),
  }),
});

export type AgentMcpRegisterInput = z.output<typeof agentMcpRegister.input>;
export type AgentMcpRegisterOutput = z.output<typeof agentMcpRegister.output>;
