import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaVersionPin } from "@oxagen/oxagen/contracts/schema.version.pin";
import { getOrCreateRegistry, pinVersion } from "./schema.versioning";
import { logger } from "./logger";

export const schemaVersionPinHandler: CapabilityHandler<
  typeof schemaVersionPin
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  const result = await pinVersion(
    ctx.orgId,
    ctx.workspaceId,
    registry.id,
    registry.id,
    input.versionId,
    ctx.userId,
  );

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      pinnedVersionId: result.pinnedVersionId,
      isDowngrade: result.isDowngrade,
    },
    "schema.version.pin: pinned version",
  );

  return result;
};
