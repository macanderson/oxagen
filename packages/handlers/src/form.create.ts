import type { CapabilityHandler } from "@oxagen/oxagen";
import { formCreate } from "@oxagen/oxagen/contracts/form.create";
import { schema, withTenantDb } from "@oxagen/database";
import { logger } from "./logger";

export const formCreateHandler: CapabilityHandler<typeof formCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    logger.warn({ orgId: ctx.orgId }, "form.create: rejected — no workspace scope");
    throw new Error("form.create requires a workspace scope");
  }
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "form.create: rejected — no authenticated user");
    throw new Error("form.create requires an authenticated user");
  }

  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.forms)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId!,
        title: input.title,
        fields: (input.fields ?? []) as unknown[],
        createdByUserId: ctx.userId!,
        updatedByUserId: ctx.userId!,
      })
      .returning({
        publicId: schema.forms.publicId,
        title: schema.forms.title,
        createdAt: schema.forms.createdAt,
      }),
  );

  if (!row) throw new Error("form.create: insert returned no row");

  logger.info(
    { publicId: row.publicId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "form.create: inserted form",
  );

  return {
    form_id: row.publicId,
    title: row.title,
    created_at: row.createdAt.toISOString(),
  };
};
