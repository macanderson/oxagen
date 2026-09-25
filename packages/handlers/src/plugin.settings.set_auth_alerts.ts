// audit-exempt: writes an org notification-preference (which roles receive MCP auth-failure emails). It is a delivery setting, not an access-control or credential change. No fitting security-event type exists in the taxonomy; covered by the kernel capability.invoke_* audit. Do not invent a type.
import { eq, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { pluginSettingsSetAuthAlerts } from "@oxagen/oxagen/contracts/plugin.settings.set_auth_alerts";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(pluginSettingsSetAuthAlerts, ctx);
  const { sendEmail, roles } = input as { sendEmail: boolean; roles: string[] };
  const orgId = ctx.orgId;

  const alertsValue = JSON.stringify({
    mcp_auth_alerts: { send_email: sendEmail, roles },
  });

  try {
    await withSystemDb(async (tx) => {
      await tx
        .update(schema.organizations)
        .set({
          settings: sql`settings || ${alertsValue}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.organizations.id, orgId));
    });
  } catch (err) {
    logger.error(
      { err, orgId, sendEmail },
      "plugin.settings.set_auth_alerts: failed",
    );
    throw err;
  }

  logger.info(
    { orgId, sendEmail, roleCount: roles.length },
    "plugin.settings.set_auth_alerts: ok",
  );
  return { ok: true };
};
