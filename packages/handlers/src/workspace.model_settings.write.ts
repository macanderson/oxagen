import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceModelSettingsWrite } from "@oxagen/oxagen/contracts/workspace.model_settings.write";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const workspaceModelSettingsWriteHandler: CapabilityHandler<
  typeof workspaceModelSettingsWrite
> = async (input, ctx) => {
  if (!ctx.workspaceId || ctx.workspaceId === "") {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.model.settings.write: rejected — no workspaceId",
    );
    throw new Error(
      "workspace.model.settings.write requires a workspace context",
    );
  }

  if (!ctx.userId) {
    logger.warn(
      { workspaceId: ctx.workspaceId },
      "workspace.model.settings.write: rejected — no authenticated user",
    );
    throw new Error(
      "workspace.model.settings.write requires an authenticated user",
    );
  }

  // Only include explicitly provided fields in the update. "not provided" means
  // leave the column unchanged; "explicitly null" clears the model preference.
  const updateSet: Record<string, unknown> = {
    updatedByUserId: ctx.userId,
  };

  if ("defaultTextTier" in input) {
    updateSet.defaultTextTier = input.defaultTextTier;
  }
  if ("defaultTextModel" in input) {
    updateSet.defaultTextModel = input.defaultTextModel;
  }
  if ("defaultImageModel" in input) {
    updateSet.defaultImageModel = input.defaultImageModel;
  }
  if ("defaultVideoModel" in input) {
    updateSet.defaultVideoModel = input.defaultVideoModel;
  }

  const [updated] = await withTenantDb((tx) =>
    tx
      .update(schema.workspaces)
      .set(updateSet as Parameters<ReturnType<typeof tx.update>["set"]>[0])
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .returning({
        defaultTextTier: schema.workspaces.defaultTextTier,
        defaultTextModel: schema.workspaces.defaultTextModel,
        defaultImageModel: schema.workspaces.defaultImageModel,
        defaultVideoModel: schema.workspaces.defaultVideoModel,
      }),
  );

  if (!updated) {
    logger.warn(
      { workspaceId: ctx.workspaceId },
      "workspace.model.settings.write: workspace not found",
    );
    throw new Error("workspace not found");
  }

  logger.info(
    { workspaceId: ctx.workspaceId, surface: ctx.surface },
    "workspace.model.settings.write: settings updated",
  );

  return {
    defaultTextTier: updated.defaultTextTier ?? null,
    defaultTextModel: updated.defaultTextModel ?? null,
    defaultImageModel: updated.defaultImageModel ?? null,
    defaultVideoModel: updated.defaultVideoModel ?? null,
  };
};
