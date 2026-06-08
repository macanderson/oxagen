import type { CapabilityHandler } from "@oxagen/oxagen";
import { promptSettingsWrite } from "@oxagen/oxagen/contracts/prompt.settings.write";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { resolveOrgTier, requireTier } from "@oxagen/billing";
import { logger } from "./logger";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Partial update of workspace.workspaces.settings.promptConfig.
//   - additionalInstructions + autoImprovePrompts: all plans.
//   - overrides (full prompt replacement): ENTERPRISE-only (requireTier throws
//     TierDeniedError otherwise — the kernel maps it to a denied result).
// The promptConfig is one key inside the broader `settings` JSONB bag, so we
// read-merge-write to preserve any other settings keys.
export const promptSettingsWriteHandler: CapabilityHandler<typeof promptSettingsWrite> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    logger.warn({ orgId: ctx.orgId }, "prompt.settings.write: rejected — no workspace context");
    throw new Error("prompt.settings.write requires a workspace context");
  }

  const hasOverrides =
    input.overrides !== undefined &&
    input.overrides !== null &&
    Object.keys(input.overrides).length > 0;

  // Enterprise gate: full prompt replacement is a hard tier cap.
  if (hasOverrides) {
    const tier = await resolveOrgTier(ctx.orgId);
    requireTier(tier, "enterprise", "prompt-overrides");
  }

  const newConfig = await withTenantDb(async (tx) => {
    const row = await tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, ctx.workspaceId),
      columns: { settings: true },
    });

    const settings: Record<string, unknown> = isRecord(row?.settings) ? { ...row.settings } : {};
    const current: Record<string, unknown> = isRecord(settings.promptConfig)
      ? { ...settings.promptConfig }
      : {};

    // Apply the partial update. `undefined` = leave unchanged; `null` = clear.
    if (input.additionalInstructions !== undefined) {
      current.additionalInstructions = input.additionalInstructions;
    }
    if (input.overrides !== undefined) {
      current.overrides = input.overrides; // null clears, object replaces the set
    }
    if (input.autoImprovePrompts !== undefined) {
      current.autoImprovePrompts = input.autoImprovePrompts;
    }

    settings.promptConfig = current;

    await tx
      .update(schema.workspaces)
      .set({ settings, updatedAt: new Date() })
      .where(eq(schema.workspaces.id, ctx.workspaceId));

    return current;
  });

  logger.info(
    { workspaceId: ctx.workspaceId, surface: ctx.surface, hasOverrides },
    "prompt.settings.write: updated prompt config",
  );

  const overrides = isRecord(newConfig.overrides)
    ? (newConfig.overrides as Record<string, string>)
    : {};

  return {
    additionalInstructions:
      typeof newConfig.additionalInstructions === "string"
        ? newConfig.additionalInstructions
        : null,
    overrides,
    autoImprovePrompts:
      typeof newConfig.autoImprovePrompts === "boolean" ? newConfig.autoImprovePrompts : true,
  };
};
