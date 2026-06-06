import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCredentialReauth = registerCapability({
  name: "plugin.credential.reauth",
  domain: "plugin",
  description:
    "Return the OAuth authorization URL to initiate re-authentication for a plugin credential that has expired or been revoked. Use this URL to deep-link the user into the OAuth consent flow.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    orgListingId: z.string().min(1),
  }),
  output: z.object({
    authorizeUrl: z.string().url(),
  }),
});
