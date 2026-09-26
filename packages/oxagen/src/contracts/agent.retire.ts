// retire_agent — retire an agent identity (MC spec §6.2, App. E; #2956). The
// principal is retired, never deleted, so its runs keep their identity: the
// agent row is archived, the principal suspended, every long-lived credential
// soft-deleted, every enrolled host revoked, and every mandate still active
// or drafted against the agent's principal revoked, in one transaction
// (ADR-106, #3124) — an active mandate does not survive its agent's
// retirement, because a suspended principal can never draw on it. Retiring
// frees the agent's runtime and harness pair for the next registration
// (ADR-192).
//
// A governance write on the identity, outside the metering surface:
// `noBillingGate: true`. Roles: org Owner or Admin (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";

export const agentRetire = registerCapability({
  name: "retire_agent",
  domain: "agent",
  description:
    "Retire an agent identity: archive the agent, suspend its principal, revoke every credential, host enrollment, and mandate. Runs keep their identity; nothing is deleted.",
  mode: "sync",
  // The handler acts as the signed-in user or the API key's creator
  // (resolveActingUserId, assertOrgRole, INV-29). The write ships on the API
  // alone: no MCP tool is built for it.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
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
      reason: z.string().max(512).optional(),
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      status: z.literal("retired"),
      revokedCredentials: z.number().int().nonnegative(),
      revokedHosts: z.number().int().nonnegative(),
      revokedMandates: z.number().int().nonnegative(),
      retiredAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type AgentRetireInput = z.output<typeof agentRetire.input>;
export type AgentRetireOutput = z.output<typeof agentRetire.output>;
