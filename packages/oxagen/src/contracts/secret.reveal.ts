import { z } from "zod";
import { registerCapability } from "../registry";

// Surfaces deliberately exclude the in-chat "agent": revealing plaintext is an
// exfiltration risk, so it is reachable only via the API or an MCP client with
// an API key (a deliberate human-configured integration). Every call is audited
// to environments.secret_access_log (Spec §7.3).
export const secretReveal = registerCapability({
  name: "reveal_secret",
  domain: "secret",
  description:
    "Reveal a single secret's plaintext value (override ?? default) for an environment. Owner/Admin only; every reveal is recorded in the access log.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  agent: { requiresApproval: true, riskLevel: "high", category: "secret" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    keyId: z.string().min(1),
    environmentId: z.string().nullable().optional(),
  }),
  output: z.object({
    key: z.string(),
    value: z.string().nullable(),
    source: z.enum(["override", "default", "unset"]),
  }),
});

export type SecretRevealInput = z.output<typeof secretReveal.input>;
export type SecretRevealOutput = z.output<typeof secretReveal.output>;
