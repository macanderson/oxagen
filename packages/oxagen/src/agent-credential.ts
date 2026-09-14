// agent-credential.ts — the API-key scope an agent's long-lived credential
// carries (MC spec §6.2: "an API key issued to the operator once, stored as a
// hash, locked to one purpose, and revocable").
//
// The scope is server-owned: `register_agent` and `rotate_agent_credential`
// are its only writers, and the generic key-management capabilities refuse to
// mint, rotate or preserve it, the same trust boundary the Tacho host scope
// keeps (packages/handlers/src/lib/tacho-enrollment.ts). A caller that could
// self-assert this purpose could present as an agent principal it never
// registered.
import { z } from "zod";

export const AGENT_CREDENTIAL_SCOPE_PURPOSE = "agent_credential_v1" as const;

export const agentCredentialScopeSchema = z
  .object({
    purpose: z.literal(AGENT_CREDENTIAL_SCOPE_PURPOSE),
    /** `agt_…` of the agent the key authenticates. */
    agent_id: z.string().regex(/^agt_[0-9a-z]+$/),
    /** `prn_…` of the agent's delegated principal. */
    principal_id: z.string().regex(/^prn_[0-9a-z]+$/),
  })
  .strict();

export type AgentCredentialScope = z.output<typeof agentCredentialScopeSchema>;

export function requestsReservedAgentCredentialPurpose(
  scope: unknown,
): boolean {
  return (
    typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    scope.purpose === AGENT_CREDENTIAL_SCOPE_PURPOSE
  );
}
