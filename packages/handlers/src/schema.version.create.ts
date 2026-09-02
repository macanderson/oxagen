import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaVersionCreate } from "@oxagen/oxagen/contracts/schema.version.create";
import { getOrCreateRegistry, publishDraft } from "./schema.versioning";
import { invalidatePinnedSchemaCache } from "./schema.pinned";
import { logger } from "./logger";

export const schemaVersionCreateHandler: CapabilityHandler<
  typeof schemaVersionCreate
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  if (!registry.draftVersionId) {
    throw new Error("No draft version found for registry");
  }

  const published = await publishDraft(
    ctx.orgId,
    ctx.workspaceId,
    registry.id,
    registry.draftVersionId,
    ctx.userId,
    input.label,
    input.changeSummary,
  );

  await invalidatePinnedSchemaCache(ctx.workspaceId);

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      versionId: published.versionId,
      versionNumber: published.versionNumber,
    },
    "schema.version.create: published draft",
  );

  return {
    versionId: published.versionId,
    versionNumber: published.versionNumber,
    publishedAt: published.publishedAt,
  };
};
