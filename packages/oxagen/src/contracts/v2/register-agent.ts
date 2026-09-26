import type { z } from "zod";
import { defineTool } from "./_define";
import { agentRegister } from "../agent.register";

/**
 * Appendix E: `register_agent`. ADR-198 replaced the job Appendix E gave it.
 *
 * Appendix E had this tool open a Context PR adding `.oxagen/agents/<slug>.toml`
 * and create the identity on merge, absorbing `create_agent_def`,
 * `suggest_agent_def` and `summarize_agent_def`. ADR-198 retired that model and
 * deleted all three contracts:
 *
 * - An agent is the IAM principal for one operator on one runtime with one
 *   harness. It carries no definition file, no prompt and no tool list of its
 *   own, so there is no file to draft (`suggest_agent_def`), write
 *   (`create_agent_def`) or summarize (`summarize_agent_def`).
 * - Registration mints the identity at once: the agent row with its runtime
 *   and toolbelt, the principal, the default role, version 1 and a credential.
 *
 * The live v1 contract already does exactly that under this tool's own name,
 * so this descriptor absorbs it and carries its schemas whole. The 18-character
 * slug cap carries with it: it keeps the agent key `org_ns.ws_ns.slug` within
 * 32 characters (ADR-024).
 */
export const registerAgent = defineTool({
  name: "register_agent",
  domain: "agent",
  description: agentRegister.description,
  mode: "sync",
  // Carried from the live contract: the output holds a credential shown once,
  // so no MCP or agent-surface tool returns it.
  surfaces: ["api", "cli"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["register_agent"],
  drops: [],

  // Carried unchanged from `register_agent`.
  agent: { requiresApproval: true, riskLevel: "high", category: "identity" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  noBillingGate: true,
  mutates: true,

  input: agentRegister.input,
  output: agentRegister.output,
});

export type RegisterAgentInput = z.output<typeof registerAgent.input>;
export type RegisterAgentOutput = z.output<typeof registerAgent.output>;
