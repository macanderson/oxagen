import { eq, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { sendEmail, roles } = input as { sendEmail: boolean; roles: string[] };
  const orgId = ctx.orgId;

  const alertsValue = JSON.stringify({ send_email: sendEmail, roles });

  await withSystemDb(async (tx) => {
    await tx
      .update(schema.organizations)
      .set({
        settings: sql`settings || ${alertsValue}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizations.id, orgId));
  });

  return { ok: true };
};
