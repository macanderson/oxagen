import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginSettingsGetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.get_auth_alerts";
import { logger } from "./logger";

/**
 * plugin.settings.get_auth_alerts handler.
 *
 * Read counterpart of set_auth_alerts: pulls `mcp_auth_alerts` out of the org
 * settings jsonb. When the org never customised the setting (or the stored
 * value is malformed), the documented default is returned with isDefault=true:
 * { sendEmail: true, roles: ["Owner", "Admin"] } — matching what the
 * notification path (notify-org-managers) assumes when unset.
 */

const VALID_ROLES = new Set(["Owner", "Admin", "Compliance", "Billing"]);
const DEFAULT_ALERTS = {
  sendEmail: true,
  roles: ["Owner", "Admin"] as ("Owner" | "Admin" | "Compliance" | "Billing")[],
  isDefault: true,
};

export const pluginSettingsGetAuthAlertsHandler: CapabilityHandler<
  typeof pluginSettingsGetAuthAlerts
> = async (_input, ctx) => {
  const { orgId } = ctx;

  const rows = await withSystemDb((tx) =>
    tx
      .select({ settings: schema.organizations.settings })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1),
  );

  const settings = rows[0]?.settings as
    | { mcp_auth_alerts?: { send_email?: unknown; roles?: unknown } }
    | null
    | undefined;
  const stored = settings?.mcp_auth_alerts;
  if (!stored || typeof stored !== "object") {
    return { ...DEFAULT_ALERTS, roles: [...DEFAULT_ALERTS.roles] };
  }

  const roles = Array.isArray(stored.roles)
    ? stored.roles.filter(
        (r): r is "Owner" | "Admin" | "Compliance" | "Billing" =>
          typeof r === "string" && VALID_ROLES.has(r),
      )
    : [];
  if (roles.length === 0 || typeof stored.send_email !== "boolean") {
    // Malformed value — fall back to the documented default rather than throw;
    // the setting is a notification preference, not a security boundary.
    logger.warn(
      { orgId },
      "plugin.settings.get_auth_alerts: malformed stored setting, returning default",
    );
    return { ...DEFAULT_ALERTS, roles: [...DEFAULT_ALERTS.roles] };
  }

  return { sendEmail: stored.send_email, roles, isDefault: false };
};
