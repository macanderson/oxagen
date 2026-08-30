import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionMappingsGet } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";

export const connectionMappingsGetHandler: CapabilityHandler<
  typeof connectionMappingsGet
> = async (input, ctx) => {
  const mappings = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.entityTypeMappings.publicId,
        sourceRecordType: schema.entityTypeMappings.sourceRecordType,
        oxagenEntityType: schema.entityTypeMappings.oxagenEntityType,
        propertyMappings: schema.entityTypeMappings.propertyMappings,
        isActive: schema.entityTypeMappings.isActive,
        createdAt: schema.entityTypeMappings.createdAt,
        updatedAt: schema.entityTypeMappings.updatedAt,
      })
      .from(schema.entityTypeMappings)
      .innerJoin(
        schema.sourceConnections,
        eq(schema.entityTypeMappings.connectionId, schema.sourceConnections.id),
      )
      .where(
        and(
          eq(schema.sourceConnections.publicId, input.connectionId),
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(schema.entityTypeMappings.createdAt),
  );

  logger.info(
    {
      connectionId: input.connectionId,
      count: mappings.length,
      orgId: ctx.orgId,
    },
    "connection.mappings.get: fetched mappings",
  );

  return {
    mappings: mappings.map((m) => ({
      ...m,
      propertyMappings: (m.propertyMappings as Record<string, string>) ?? {},
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
  };
};
