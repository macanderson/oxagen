import type { z } from "zod";
import { defineTool } from "./_define";
import { agentList } from "../agent.list";

/**
 * Appendix E: `list_agents`. Blank Does column: the job is unchanged.
 *
 * Appendix E had it absorb `list_agent_defs`, which listed agent definitions
 * with their tool refs and latest version. ADR-192 deleted that contract with
 * the definition file it read: an agent carries no definition, so there is no
 * definition to list. The live `list_agents` contract answers the question the
 * Agents page asks, one row per agent with its runtime, toolbelt, operator,
 * status and 30-day figures, so this descriptor absorbs it and carries its
 * schemas whole.
 */
export const listAgents = defineTool({
  name: "list_agents",
  domain: "agent",
  description: agentList.description,
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["list_agents"],
  drops: [],

  // Carried unchanged from `list_agents`.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  noBillingGate: true,
  mutates: false,

  input: agentList.input,
  output: agentList.output,
});

export type ListAgentsInput = z.output<typeof listAgents.input>;
export type ListAgentsOutput = z.output<typeof listAgents.output>;
