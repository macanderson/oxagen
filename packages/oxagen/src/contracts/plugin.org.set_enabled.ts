import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginOrgSetEnabled = registerCapability({
  name: "plugin.org.set_enabled",
  domain: "plugin",
  description: "Toggle the enabled flag on an org-level plugin listing.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    orgListingId: z.string(),
    enabled: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
