// audit-exempt: workspace prompt-config edit (additional instructions / overrides / auto-improve toggle) — a behavioural tuning setting, not an access-control or credential change. No fitting security-event type exists in the taxonomy; covered by the kernel capability.invoke_* audit. Do not invent a type.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { promptSettingsWrite } from "@oxagen/oxagen/contracts/prompt.settings.write";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
import { resolveOrgTier, requireTier } from "@oxagen/billing";
import { logger } from "./logger";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Partial update of workspace.workspaces.prompt_config (its own column since
// audit §1.7).
//   - additionalInstructions + autoImprovePrompts: all plans.
//   - overrides (full prompt replacement): ENTERPRISE-only (requireTier throws
//     TierDeniedError otherwise — the kernel maps it to a denied result).
// Merged ATOMICALLY via jsonb `||` in a single UPDATE (no read-modify-write), so
// concurrent writers cannot lose each other's subkeys.
export const promptSettingsWriteHandler: CapabilityHandler<
  typeof promptSettingsWrite
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "prompt.settings.write: rejected — no workspace context",
    );
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

  // Build the partial patch from only the provided fields. `undefined` = leave
  // unchanged (key absent from the patch); `null` = clear (merged as JSON null,
  // which the readers coalesce). jsonb `||` is a shallow merge, so unspecified
  // subkeys on the existing prompt_config survive.
  const patch: Record<string, unknown> = {};
  if (input.additionalInstructions !== undefined) {
    patch.additionalInstructions = input.additionalInstructions;
  }
  if (input.overrides !== undefined) patch.overrides = input.overrides;
  if (input.autoImprovePrompts !== undefined) {
    patch.autoImprovePrompts = input.autoImprovePrompts;
  }

  const newConfig = await withTenantDb(async (tx) => {
    const [updated] = await tx
      .update(schema.workspaces)
      .set({
        promptConfig: sql`coalesce(${schema.workspaces.promptConfig}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .returning({ promptConfig: schema.workspaces.promptConfig });

    return isRecord(updated?.promptConfig) ? updated.promptConfig : {};
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
      typeof newConfig.autoImprovePrompts === "boolean"
        ? newConfig.autoImprovePrompts
        : true,
  };
};
