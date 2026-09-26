import { z } from "zod";
import { defineTool } from "./_define";
import { agentMove } from "../agent.move";
import { agentToolbeltAssign } from "../agent.toolbelt.assign";
import { runtimeRefSchema } from "../runtime.shared";
import { toolbeltRefSchema } from "../toolbelt.shared";

/**
 * Appendix E: `update_agent`, "identity and belt update". ADR-192 replaced the
 * mechanism and narrowed what an update can change.
 *
 * Appendix E had it open a Context PR changing `.oxagen/agents/<slug>.toml`,
 * absorbing `update_agent_def`, `revise_agent_def`, `publish_agent_def` and
 * `deploy_agent`. ADR-192 deleted all four with the definition file:
 *
 * - An agent carries no config, prompt or instructions, so there is nothing to
 *   edit (`update_agent_def`), revise from a prompt (`revise_agent_def`) or
 *   publish (`publish_agent_def`).
 * - `deploy_agent` toggled an agent's triggers on and off. A wrapped agent is
 *   stopped by its kill switch, suspension or retirement instead.
 *
 * What changes on an agent now is its runtime and its toolbelt. The principal,
 * the operator and the harness never change. Each change writes an agent
 * version and keeps the principal, its roles and its runs. The live v1
 * contracts for those two changes are `move_agent` and `assign_agent_toolbelt`,
 * so this descriptor absorbs both and carries their inputs: name the agent and
 * a new runtime, a new toolbelt, or both.
 */
export const updateAgentInputObject = z.object({
  // Carried from both sources: agent public id (`agt_…`) or slug.
  agentId: agentMove.input.shape.agentId,
  /** Carried from `move_agent`: the runtime to move the agent to. */
  runtimeId: agentMove.input.shape.runtimeId.optional(),
  /** Carried from `assign_agent_toolbelt`: the toolbelt the agent carries next. */
  toolbeltId: agentToolbeltAssign.input.shape.toolbeltId.optional(),
});

const updateAgentInput = updateAgentInputObject.superRefine((value, ctx) => {
  if (value.runtimeId === undefined && value.toolbeltId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "name a runtimeId, a toolbeltId or both: an update with nothing to change would write an empty agent version",
    });
  }
});

export const updateAgent = defineTool({
  name: "update_agent",
  domain: "agent",
  description:
    "Move an agent to another runtime, give it another toolbelt, or both. Each change writes a new agent version and keeps the principal, its roles and its runs. A move revokes the agent's live host enrollments on the old runtime.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["move_agent", "assign_agent_toolbelt"],
  drops: [],

  /**
   * `move_agent` is high risk and high sensitivity, `assign_agent_toolbelt`
   * medium risk and high sensitivity. The stricter carries, because a move
   * revokes live host enrollments.
   */
  agent: { requiresApproval: true, riskLevel: "high", category: "identity" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    // Identical across both sources.
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  noBillingGate: true,
  mutates: true,

  input: updateAgentInput,

  output: z.object({
    agentId: agentMove.output.shape.agentId,
    /** The runtime after the update; null when the call did not move the agent. */
    runtime: runtimeRefSchema.nullable(),
    /** The toolbelt after the update; null when the call did not change it. */
    toolbelt: toolbeltRefSchema.nullable(),
    /** The newest `agent_versions.version` the update wrote. */
    version: agentMove.output.shape.version,
    /** Host enrollments on the old runtime a move revoked; 0 without a move. */
    revokedHosts: agentMove.output.shape.revokedHosts,
  }),
});

export type UpdateAgentInput = z.output<typeof updateAgent.input>;
export type UpdateAgentOutput = z.output<typeof updateAgent.output>;
