import type { CapabilityHandler } from "@oxagen/oxagen";
import { formSubmit } from "@oxagen/oxagen/contracts/form.submit";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const formSubmitHandler: CapabilityHandler<typeof formSubmit> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    logger.warn({ orgId: ctx.orgId }, "form.submit: rejected — no workspace scope");
    throw new Error("form.submit requires a workspace scope");
  }
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "form.submit: rejected — no authenticated user");
    throw new Error("form.submit requires an authenticated user");
  }

  // Resolve the form's internal UUID from its public id + workspace scope.
  const formRows = await withTenantDb((tx) =>
    tx
      .select({ id: schema.forms.id })
      .from(schema.forms)
      .where(
        and(
          eq(schema.forms.publicId, input.form_id),
          eq(schema.forms.workspaceId, ctx.workspaceId!),
          isNull(schema.forms.deletedAt),
        ),
      )
      .limit(1),
  );

  const form = formRows[0];
  if (!form) {
    logger.warn(
      { formId: input.form_id, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "form.submit: form not found",
    );
    throw new Error(`form.submit: form "${input.form_id}" not found`);
  }

  // Insert the submission, linking to the resolved internal form UUID.
  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.formSubmissions)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId!,
        formId: form.id,
        responses: (input.responses ?? {}) as Record<string, unknown>,
        createdByUserId: ctx.userId!,
        updatedByUserId: ctx.userId!,
      })
      .returning({
        publicId: schema.formSubmissions.publicId,
        status: schema.formSubmissions.status,
        createdAt: schema.formSubmissions.createdAt,
      }),
  );

  if (!row) throw new Error("form.submit: insert returned no row");

  logger.info(
    {
      submissionId: row.publicId,
      formId: input.form_id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "form.submit: inserted submission",
  );

  return {
    submission_id: row.publicId,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
};
