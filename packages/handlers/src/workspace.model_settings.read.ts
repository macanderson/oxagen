import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceModelSettingsRead } from "@oxagen/oxagen/contracts/workspace.model_settings.read";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const workspaceModelSettingsReadHandler: CapabilityHandler<
  typeof workspaceModelSettingsRead
> = async (_input, ctx) => {
  if (!ctx.workspaceId || ctx.workspaceId === "") {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.model.settings.read: rejected — no workspaceId",
    );
    throw new Error(
      "workspace.model.settings.read requires a workspace context",
    );
  }

  const row = await withTenantDb((tx) =>
    tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ctx.workspaceId),
      columns: {
        defaultTextTier: true,
        defaultTextModel: true,
        defaultImageModel: true,
        defaultVideoModel: true,
      },
    }),
  );

  if (!row) {
    logger.info(
      { workspaceId: ctx.workspaceId },
      "workspace.model.settings.read: no row — returning null defaults",
    );
    return {
      defaultTextTier: null,
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    };
  }

  logger.info(
    { workspaceId: ctx.workspaceId, surface: ctx.surface },
    "workspace.model.settings.read: returned settings",
  );

  return {
    defaultTextTier: row.defaultTextTier ?? null,
    defaultTextModel: row.defaultTextModel ?? null,
    defaultImageModel: row.defaultImageModel ?? null,
    defaultVideoModel: row.defaultVideoModel ?? null,
  };
};
