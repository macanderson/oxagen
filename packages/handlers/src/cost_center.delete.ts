// `delete_cost_center` (ADR-142): soft-delete a label. The row stays, so past
// statements still name it; the rollup stops charging new runs to it. Governed
// by the kernel's capability.invoke_* audit; no domain event type fits.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import type { costCenterDelete } from "@oxagen/oxagen/contracts/cost_center.delete";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { COST_CENTER_EDITORS } from "./cost_center.create";
import { readLiveCostCenter } from "./cost_center.shared";

export const costCenterDeleteHandler: CapabilityHandler<
  typeof costCenterDelete
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, COST_CENTER_EDITORS);
  const now = new Date();
  const row = await withTenantDb(async (tx) => {
    const live = await readLiveCostCenter(tx, ctx.orgId, input.label);
    if (!live) {
      throw new HandlerError({
        code: "not_found",
        reason: "cost_center_not_found",
        message: `No cost center ${input.label} is on the list`,
      });
    }
    const [deleted] = await tx
      .update(schema.costCenters)
      .set({
        deletedAt: now,
        deletedById: userId,
        updatedAt: now,
        updatedById: userId,
      })
      .where(eq(schema.costCenters.id, live.id))
      .returning();
    return deleted;
  });
  if (!row?.deletedAt)
    throw new Error("delete_cost_center: the label was not deleted");
  return { label: row.label, deletedAt: row.deletedAt.toISOString() };
};
