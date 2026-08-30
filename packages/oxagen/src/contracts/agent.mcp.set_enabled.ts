import { z } from "zod";
import { registerCapability } from "../registry";

export const agentMcpSetEnabled = registerCapability({
  name: "set_mcp_enabled",
  domain: "agent",
  description:
    "Enable or disable a registered external MCP server. Disabling stops its tools from registering but keeps tool-descriptor snapshots for replay; re-enabling re-captures snapshots. The change is audited.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    mcpServerId: z.string(),
    enabled: z.boolean(),
  }),
  output: z.object({
    mcpServerId: z.string(),
    enabled: z.boolean(),
    snapshotCount: z.number().int().nonnegative(),
  }),
});

export type AgentMcpSetEnabledInput = z.output<typeof agentMcpSetEnabled.input>;
export type AgentMcpSetEnabledOutput = z.output<
  typeof agentMcpSetEnabled.output
>;
