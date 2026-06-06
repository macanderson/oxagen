import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId } = input as { orgListingId: string };

  await withSystemDb(async (tx) => {
    // Soft-delete the listing (scoped to this org).
    await tx
      .update(schema.pluginOrgListings)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(schema.pluginOrgListings.id, orgListingId),
          eq(schema.pluginOrgListings.orgId, ctx.orgId),
        ),
      );

    // Hard-delete dependent workspace installs so the runtime drops them.
    await tx
      .delete(schema.mcpServers)
      .where(eq(schema.mcpServers.orgListingId, orgListingId));
  });

  return { ok: true };
};
