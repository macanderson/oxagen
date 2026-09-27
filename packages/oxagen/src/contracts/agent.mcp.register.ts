import { z } from "zod";
import { registerCapability } from "../registry";

export const agentMcpRegister = registerCapability({
  name: "register_mcp_server",
  domain: "agent",
  description:
    "Register an external MCP server with the workspace; its tools become available to the agent after health check. Once the workspace's tools live in its steering repo, a remote server is proposed through a steering PR instead and stays off until that PR merges.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
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
    /**
     * Set when the workspace's tools live in its steering repo: the steering
     * PR that adds the server. The server stays off until the PR merges and
     * the next publish connects it.
     */
    steeringPr: z
      .object({ number: z.number().int().positive(), url: z.string().url() })
      .optional(),
  }),
});

export type AgentMcpRegisterInput = z.output<typeof agentMcpRegister.input>;
export type AgentMcpRegisterOutput = z.output<typeof agentMcpRegister.output>;
