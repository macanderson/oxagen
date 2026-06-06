import { or, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (_input, ctx) => {
  const orgId = ctx.orgId;
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(schema.mcpRegistries)
      .where(or(isNull(schema.mcpRegistries.orgId), eq(schema.mcpRegistries.orgId, orgId))),
  );
  return {
    registries: rows.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      enabled: r.enabled,
      isDefaultSeed: r.isDefaultSeed,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    })),
  };
};
