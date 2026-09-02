import { z } from "zod";
import { registerCapability } from "../registry";

export const secretValueSet = registerCapability({
  name: "set_secret_value",
  domain: "secret",
  description:
    "Set a secret's value override for a specific environment. Encrypted or plaintext per the key's sensitive flag.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "high", category: "secret" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    keyId: z.string().min(1),
    environmentId: z.string().min(1),
    value: z.string(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type SecretValueSetInput = z.output<typeof secretValueSet.input>;
