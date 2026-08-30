import type { CapabilityHandler } from "@oxagen/oxagen";
import { promptSettingsRead } from "@oxagen/oxagen/contracts/prompt.settings.read";
import { loadWorkspacePromptConfig } from "@oxagen/ai";
import { logger } from "./logger";

// Reads the workspace prompt config from the workspace.workspaces.prompt_config
// column (via the shared loader, which normalizes the untrusted JSONB). autoImprovePrompts
// defaults to ON — the beta prompt-enhancement judge is on unless turned off.
export const promptSettingsReadHandler: CapabilityHandler<
  typeof promptSettingsRead
> = async (_input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "prompt.settings.read: rejected — no workspace context",
    );
    throw new Error("prompt.settings.read requires a workspace context");
  }

  const config = await loadWorkspacePromptConfig(ctx.workspaceId);

  logger.info(
    { workspaceId: ctx.workspaceId, surface: ctx.surface },
    "prompt.settings.read: returned prompt config",
  );

  return {
    additionalInstructions: config.additionalInstructions ?? null,
    overrides: config.overrides ?? {},
    autoImprovePrompts: config.autoImprovePrompts ?? true,
  };
};
