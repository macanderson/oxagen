import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageList } from "@oxagen/oxagen/contracts/image.list";
import { logger } from "./logger";

// ── Handler ───────────────────────────────────────────────────────────────────
//
// Lists images in the workspace by querying the generated_assets table.
// Filters to: kind='image', workspaceId=ctx.workspaceId, status='ready',
// deletedAt IS NULL. Results are ordered newest-first.
//
// Tenancy: withTenantDb runs inside the kernel-injected RLS tenant scope so
// no cross-workspace leakage is possible.

export const imageListHandler: CapabilityHandler<typeof imageList> = async (
  _input,
  ctx,
) => {
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "image.list: querying workspace images",
  );

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.generatedAssets.publicId,
        storageUrl: schema.generatedAssets.storageUrl,
        createdAt: schema.generatedAssets.createdAt,
        prompt: schema.generatedAssets.prompt,
      })
      .from(schema.generatedAssets)
      .where(
        and(
          eq(schema.generatedAssets.kind, "image"),
          eq(schema.generatedAssets.workspaceId, ctx.workspaceId),
          eq(schema.generatedAssets.status, "ready"),
          isNull(schema.generatedAssets.deletedAt),
        ),
      )
      .orderBy(desc(schema.generatedAssets.createdAt)),
  );

  return {
    images: rows.map((r) => ({
      id: r.publicId,
      url: r.storageUrl ?? `/api/v1/assets/${r.publicId}`,
      created_at: r.createdAt.toISOString(),
      prompt: r.prompt,
    })),
  };
};
