import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { name, baseUrl } = input as { name: string; baseUrl: string };
  const rows = await withSystemDb((tx) =>
    tx
      .insert(schema.mcpRegistries)
      .values({ orgId: ctx.orgId, name, baseUrl, enabled: true, isDefaultSeed: false })
      .returning({ id: schema.mcpRegistries.id }),
  );
  const row = rows[0];
  if (!row) throw new Error("registry insert returned no row");
  return { registryId: row.id };
};
