// move_agent — put an agent on another runtime and keep its identity
// (ADR-192, #4369).
//
// A move is how an agent survives new hardware or a cloud migration. The
// principal, its roles, its credentials and its runs stay; the handler writes
// a new `agent_versions` row (`runtime_changed`) and revokes the agent's live
// host enrollments on the old runtime, the same three writes
// `revoke_tacho_enrollment` makes. The new machine then enrolls with a token
// minted for the agent (`create_enrollment_token`).
//
// A runtime that already runs a live agent with the same harness is refused
// with `conflict`, reason `runtime_harness_taken`. Moving to the runtime the
// agent is already on is refused with `conflict`, reason `same_runtime`. A
// retired agent is refused with `conflict`, reason `agent_retired`.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";
import { runtimeIdSchema, runtimeRefSchema } from "./runtime.shared";

export const agentMove = registerCapability({
  name: "move_agent",
  domain: "agent",
  description:
    "Move an agent to another runtime and keep its principal, roles and runs. Writes a new agent version and revokes its live host enrollments on the old runtime.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
      runtimeId: runtimeIdSchema,
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      runtime: runtimeRefSchema,
      /** The `agent_versions.version` the move wrote. */
      version: z.number().int().positive(),
      /** Host enrollments on the old runtime the move revoked. */
      revokedHosts: z.number().int().nonnegative(),
    })
    .strict(),
});
