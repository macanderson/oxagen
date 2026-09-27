// assign_agent_toolbelt — give an agent another toolbelt and keep its
// identity (ADR-198, #4369).
//
// The handler writes a new `agent_versions` row (`toolbelt_changed`) and moves
// `agent.agents.toolbelt_id`. The principal, its roles and its grants do not
// change: a belt narrows what the agent is shown and never widens what it may
// do. Assigning the belt the agent already carries is refused with
// `conflict`, reason `same_toolbelt`; a retired agent with `conflict`, reason
// `agent_retired`.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";
import { toolbeltIdSchema, toolbeltRefSchema } from "./toolbelt.shared";

export const agentToolbeltAssign = registerCapability({
  name: "assign_agent_toolbelt",
  domain: "agent",
  description:
    "Give an agent another toolbelt and keep its principal, roles and grants. Writes a new agent version.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "tools" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      /** Agent public id (`agt_…`) or slug. */
      agentId: z.string().min(1).max(128),
      toolbeltId: toolbeltIdSchema,
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      toolbelt: toolbeltRefSchema,
      /** The `agent_versions.version` the assignment wrote. */
      version: z.number().int().positive(),
    })
    .strict(),
});
