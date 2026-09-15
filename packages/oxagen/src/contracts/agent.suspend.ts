// suspend_agent — stop an agent identity without retiring it (MC spec §6.2;
// #2956). The principal's status becomes `suspended`: the runtime builds no
// run context for a suspended principal (packages/iam/src/agent-run-context.ts),
// so no governed run starts for it and `get_agent_toolbelt` reports an empty
// belt. Credentials, roles and hosts stay as they are so `resume` is one
// status write back to `active`. The long-lived credential is locked to the
// run-token exchange of spec §6.2, which no surface serves yet (ADR-057 §4).
//
// A governance write on the identity, outside the metering surface:
// `noBillingGate: true`. Roles: org Owner or Admin (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSuspend = registerCapability({
  name: "suspend_agent",
  domain: "agent",
  description:
    "Suspend or resume an agent identity: a suspended principal anchors no governed run and its belt is empty; resuming restores it without re-issuing anything.",
  mode: "sync",
  // The handler acts as the signed-in user or the API key's creator
  // (resolveActingUserId, assertOrgRole, INV-29). The write ships on the API
  // alone: no MCP tool is built for it.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "identity" },
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
      /** `false` resumes a suspended agent. */
      suspended: z.boolean().default(true),
      reason: z.string().max(512).optional(),
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      status: z.enum(["suspended", "active"]),
      changedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type AgentSuspendInput = z.output<typeof agentSuspend.input>;
export type AgentSuspendOutput = z.output<typeof agentSuspend.output>;
