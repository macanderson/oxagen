// suspend_agent — stop an agent identity without retiring it (MC spec §6.2;
// #2956). The principal's status becomes `suspended`, which invalidates every
// run token at its next call and is the one-second revocation the identity
// half exists for. Credentials, roles and hosts stay as they are so `resume`
// is one status write back to `active`.
//
// A governance write on the identity, outside the metering surface:
// `noBillingGate: true`. Roles: org Owner or Admin (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSuspend = registerCapability({
  name: "suspend_agent",
  domain: "agent",
  description:
    "Suspend or resume an agent identity: a suspended principal fails every run token at its next call; resuming restores it without re-issuing anything.",
  mode: "sync",
  // The handler requires a signed-in user (assertOrgRole, INV-29). The MCP
  // server builds every context with `userId: null` (apps/mcp/src/context.ts),
  // so the write ships on the API alone; `tacho.enrollment.create` set the
  // pattern for a user-bound write.
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
