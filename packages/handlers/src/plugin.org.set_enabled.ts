import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, enabled } = input as { orgListingId: string; enabled: boolean };

  await withSystemDb(async (tx) => {
    await tx
      .update(schema.pluginOrgListings)
      .set({ enabled })
      .where(
        and(
          eq(schema.pluginOrgListings.id, orgListingId),
          eq(schema.pluginOrgListings.orgId, ctx.orgId),
        ),
      );
  });

  return { ok: true };
};
