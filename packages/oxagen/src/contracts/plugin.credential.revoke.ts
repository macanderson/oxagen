import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCredentialRevoke = registerCapability({
  name: "revoke_plugin_credential",
  domain: "plugin",
  description:
    "Revoke and delete the stored credential (OAuth tokens or secret) for an installed plugin server in this workspace, so the workspace must re-authenticate before the server can be used again.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    orgListingId: z.string().min(1),
  }),
  output: z.object({
    revoked: z.boolean(),
  }),
});
