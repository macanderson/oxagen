import type { z } from "zod";
import { defineTool } from "./_define";
import { agentRetire } from "../agent.retire";

/**
 * Appendix E: `retire_agent`, "principal retired, never deleted". ADR-198 kept
 * the outcome and replaced the mechanism.
 *
 * Appendix E had it open a Context PR removing `.oxagen/agents/<slug>.toml`,
 * absorbing `delete_agent_def`. ADR-198 deleted that contract with the
 * definition file: an agent carries no file to remove. Retirement is one write
 * that archives the agent, suspends its principal, and revokes its
 * credentials, host enrollments and mandates. Nothing is deleted, so past runs
 * keep their identity, and the runtime and harness pair it held is free for the
 * next registration.
 *
 * The live v1 contract does exactly that under this tool's own name, so this
 * descriptor absorbs it and carries its schemas whole.
 */
export const retireAgent = defineTool({
  name: "retire_agent",
  domain: "agent",
  description: agentRetire.description,
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["retire_agent"],
  drops: [],

  // Carried unchanged from `retire_agent`.
  agent: { requiresApproval: true, riskLevel: "high", category: "identity" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  noBillingGate: true,
  mutates: true,

  input: agentRetire.input,
  output: agentRetire.output,
});

export type RetireAgentInput = z.output<typeof retireAgent.input>;
export type RetireAgentOutput = z.output<typeof retireAgent.output>;
