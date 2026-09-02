import { z } from "zod";
import { registerCapability } from "../registry";

export const secretValueUnset = registerCapability({
  name: "unset_secret_value",
  domain: "secret",
  description:
    "Remove a secret's per-environment override so it falls back to the key's default value.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "medium", category: "secret" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    keyId: z.string().min(1),
    environmentId: z.string().min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type SecretValueUnsetInput = z.output<typeof secretValueUnset.input>;
