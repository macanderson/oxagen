import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * plugin.settings.set_auth_alerts — update the org's mcp_auth_alerts setting.
 * Default (when unset): { send_email: true, roles: ["Owner", "Admin"] }.
 * Only org Owners and Admins may change this setting.
 */
export const pluginSettingsSetAuthAlerts = registerCapability({
  name: "set_auth_alerts",
  domain: "plugin",
  description:
    "Update the org MCP auth-alert notification setting (which roles receive alerts and whether email is sent).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  // "app": configurable from org Governance → Policies (binding in
  // apps/app/capability-ui-map.json — UI Capability Parity law).
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    /** Whether to send email in addition to in-app notification. */
    sendEmail: z.boolean(),
    /**
     * Org role names that should receive alerts.
     * Must be a non-empty subset of valid org roles.
     */
    roles: z.array(z.enum(["Owner", "Admin", "Compliance", "Billing"])).min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type PluginSettingsSetAuthAlertsInput = z.output<
  typeof pluginSettingsSetAuthAlerts.input
>;
