import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { registryId } = input as { registryId: string };
  const deleted = await withSystemDb((tx) =>
    tx
      .delete(schema.mcpRegistries)
      .where(
        and(
          eq(schema.mcpRegistries.id, registryId),
          eq(schema.mcpRegistries.orgId, ctx.orgId),
          eq(schema.mcpRegistries.isDefaultSeed, false),
        ),
      )
      .returning({ id: schema.mcpRegistries.id }),
  );
  return { ok: deleted.length > 0 };
};
