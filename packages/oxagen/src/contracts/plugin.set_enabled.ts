import { z } from "zod";
import { registerCapability } from "../registry";

// Single scope-parameterised capability for enabling/disabling a plugin listing.
// `scope` selects the target:
//   - "org":       toggles the `enabled` flag on the org's installed-plugin row
//                  (the marketplace listing). Only enabled listings are surfaced
//                  to workspaces for activation.
//   - "workspace": enables/disables the plugin *server* for this workspace —
//                  enabling upserts an agent.mcp_servers row from the org listing
//                  (marketplace install path); disabling sets that row disabled
//                  (credentials preserved).
// (ADR-025 §3: scope is an argument, not two separate capabilities.)
export const pluginSetEnabled = registerCapability({
  name: "set_plugin_enabled",
  domain: "plugin",
  description:
    "Enable or disable a plugin listing. scope='org' toggles the org listing's enabled flag; scope='workspace' upserts/disables an agent.mcp_servers row for this workspace from the org listing.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    scope: z.enum(["org", "workspace"]),
    orgListingId: z.string(),
    enabled: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
    // Populated only for scope="workspace" enables: the public ID of the
    // upserted agent.mcp_servers row (null on workspace disable, and always null
    // for scope="org").
    workspaceServerId: z.string().nullable(),
  }),
});
