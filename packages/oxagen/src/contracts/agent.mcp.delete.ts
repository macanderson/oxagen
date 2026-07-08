import { z } from "zod";
import { registerCapability } from "../registry";

export const agentMcpDelete = registerCapability({
  name: "agent.mcp.delete",
  domain: "agent",
  description:
    "Soft-delete a registered external MCP server. Its tools stop registering immediately, but tool-descriptor snapshots are retained >= 365 days for replay durability before a retention job purges them. The change is audited.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    mcpServerId: z.string(),
  }),
  output: z.object({
    mcpServerId: z.string(),
    deleted: z.boolean(),
  }),
});

export type AgentMcpDeleteInput = z.output<typeof agentMcpDelete.input>;
export type AgentMcpDeleteOutput = z.output<typeof agentMcpDelete.output>;
