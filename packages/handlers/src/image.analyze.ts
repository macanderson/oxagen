import { z } from "zod";
import {
  generateObjectFor,
  selectModel,
  resolvePrompt,
  imageAnalyzePrompt,
  loadWorkspacePromptConfigSafe,
} from "@oxagen/ai";
import { schema, withSystemDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageAnalyze } from "@oxagen/oxagen/contracts/image.analyze";
import type { ModelMessage } from "ai";
import { logger } from "./logger";

// ── Handler ───────────────────────────────────────────────────────────────────
//
// Resolves an image asset by public id (within the caller's workspace), builds
// a multimodal ModelMessage with the image URL, and calls generateObjectFor()
// to produce a structured { analysis, tags, description }.
//
// Asset lookup uses withSystemDb because the caller's workspace scope is carried
// by orgId/workspaceId from the capability context and enforced explicitly in the
// WHERE clause — there is no runInTenantScope active for this standalone lookup.
//
// NOTE: the lookup checks org + workspace only. It does NOT re-apply the asset's
// per-asset `access_policy` the way generated-asset.serve does, so an asset with
// policy `user` can be analysed by any workspace member, not just its creator.

const analysisSchema = z.object({
  analysis: z.string(),
  tags: z.array(z.string()),
  description: z.string(),
});

export const imageAnalyzeHandler: CapabilityHandler<
  typeof imageAnalyze
> = async (input, ctx) => {
  // ── 1. Resolve the asset row ─────────────────────────────────────────────────
  const [asset] = await withSystemDb((tx) =>
    tx
      .select({
        storageUrl: schema.generatedAssets.storageUrl,
        mimeType: schema.generatedAssets.mimeType,
      })
      .from(schema.generatedAssets)
      .where(
        and(
          eq(schema.generatedAssets.publicId, input.image_id),
          eq(schema.generatedAssets.orgId, ctx.orgId),
          eq(schema.generatedAssets.workspaceId, ctx.workspaceId),
          eq(schema.generatedAssets.status, "ready"),
          isNull(schema.generatedAssets.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!asset?.storageUrl) {
    logger.warn(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        imageId: input.image_id,
      },
      "image.analyze: asset not found or not ready",
    );
    throw new Error(`Asset ${input.image_id} not found or not ready`);
  }

  // ── 2. Build the multimodal message ──────────────────────────────────────────
  // The analysis instruction is the overridable "image.analyze" content prompt;
  // resolve it through the registry so an enterprise workspace can tailor the
  // analysis voice/focus and append workspace instructions.
  const promptConfig = await loadWorkspacePromptConfigSafe(ctx.workspaceId);
  const instruction = resolvePrompt({
    key: "image.analyze",
    baseline: imageAnalyzePrompt(),
    config: promptConfig,
  });
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          image: asset.storageUrl,
          mediaType: asset.mimeType as
            | "image/png"
            | "image/jpeg"
            | "image/webp"
            | "image/gif",
        },
        { type: "text", text: instruction },
      ],
    },
  ];

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, imageId: input.image_id },
    "image.analyze: calling generateObjectFor",
  );

  // ── 3. Generate structured analysis via the AI chokepoint ───────────────────
  const { object } = await generateObjectFor({
    schema: analysisSchema,
    model: selectModel(),
    messages,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      // requestId/messageId are UUIDs; null (not "unknown") when neither is
      // present — this id lands in token_usage's UUID column and credit_ledger's
      // uuid column.
      messageId: ctx.messageId ?? ctx.requestId ?? null,
    },
  });

  return {
    analysis: object.analysis,
    tags: object.tags,
    description: object.description,
  };
};
