import { z } from "zod";
import { registerCapability } from "../registry";

export const secretKeyDelete = registerCapability({
  name: "delete_secret_key",
  domain: "secret",
  description:
    "Soft-delete a vault secret key and hard-remove all of its per-environment overrides.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "high", category: "secret" },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ keyId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export type SecretKeyDeleteInput = z.output<typeof secretKeyDelete.input>;
