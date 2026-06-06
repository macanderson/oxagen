import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCredentialSetSecret = registerCapability({
  name: "plugin.credential.set_secret",
  domain: "plugin",
  description: "Store or update an encrypted credential (API key or OAuth token) for a plugin server in this workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "high", category: "plugin" },
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    orgListingId: z.string(),
    authKind: z.enum(["oauth", "secret"]),
    secret: z.string().optional(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
