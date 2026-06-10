import { eq, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { sendEmail, roles } = input as { sendEmail: boolean; roles: string[] };
  const orgId = ctx.orgId;

  const alertsValue = JSON.stringify({ mcp_auth_alerts: { send_email: sendEmail, roles } });

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
    logger.error({ err, orgId, sendEmail }, "plugin.settings.set_auth_alerts: failed");
    throw err;
  }

  logger.info({ orgId, sendEmail, roleCount: roles.length }, "plugin.settings.set_auth_alerts: ok");
  return { ok: true };
};
