import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * plugin.settings.get_auth_alerts — read the org's mcp_auth_alerts setting.
 *
 * Read counterpart of set_auth_alerts: which org roles receive MCP auth-failure
 * alerts and whether email delivery is on. Returns the documented default
 * ({ sendEmail: true, roles: ["Owner", "Admin"] }) when the org has never
 * customised the setting. Powers the org Governance → Policies alerts panel.
 */

const orgRole = z.enum(["Owner", "Admin", "Compliance", "Billing"]);

export const pluginSettingsGetAuthAlerts = registerCapability({
  name: "get_auth_alerts",
  domain: "plugin",
  description:
    "Read the org MCP auth-alert notification setting — which org roles receive alerts and whether email is sent. Returns the default (email on, Owner + Admin) when unset.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // A notification-preference read; must not consume credits or be balance-gated.
  noBillingGate: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({}),
  output: z.object({
    sendEmail: z
      .boolean()
      .describe("Whether email is sent in addition to in-app notification"),
    roles: z.array(orgRole).min(1).describe("Org roles that receive MCP auth alerts"),
    isDefault: z
      .boolean()
      .describe("True when the org has never customised the setting"),
  }),
});

export type PluginSettingsGetAuthAlertsOutput = z.output<
  typeof pluginSettingsGetAuthAlerts.output
>;
