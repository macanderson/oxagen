// rotate_agent_credential — replace an agent's long-lived credential (MC spec
// §6.2; #2956). The previous key is soft-deleted in the same transaction the
// new one is minted, so there is no moment with two live secrets and none
// with zero. The old secret is refused at its next presentation. The new
// secret is returned once.
//
// A credential write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";

const MAX_VALIDITY_DAYS = 365;

export const agentCredentialRotate = registerCapability({
  name: "rotate_agent_credential",
  domain: "agent",
  description:
    "Rotate an agent's long-lived credential: retire the current key and mint a replacement, returned once.",
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
      validityDays: z.number().int().min(1).max(MAX_VALIDITY_DAYS).default(180),
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      /** The credential that was retired; null when the agent held none. */
      revokedCredentialId: z
        .string()
        .regex(/^aky_[0-9a-z]+$/)
        .nullable(),
      credential: z
        .object({
          id: z.string().regex(/^aky_[0-9a-z]+$/),
          /** Shown once. Never recoverable. */
          secret: z.string().min(1),
          expiresAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    })
    .strict(),
});

export type AgentCredentialRotateInput = z.output<
  typeof agentCredentialRotate.input
>;
export type AgentCredentialRotateOutput = z.output<
  typeof agentCredentialRotate.output
>;
