// `create_cost_center` (ADR-142): add a label to the organization's list, or
// restore one the organization deleted. Governed by the kernel's
// capability.invoke_* audit; no domain event type fits a chargeback label, and
// the taxonomy is not widened to satisfy a handler.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import type { costCenterCreate } from "@oxagen/oxagen/contracts/cost_center.create";
import { isUniqueViolation, schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { toCostCenter } from "./cost_center.shared";

const centers = schema.costCenters;

/** Who may edit the list: the people accountable for the bill. */
export const COST_CENTER_EDITORS = {
  org: ["Owner", "Admin", "Billing"],
} as const;

export const costCenterCreateHandler: CapabilityHandler<
  typeof costCenterCreate
> = async (input, ctx) => {
  // The kernel's IAM check fast-paths non-enterprise humans, so the org role
  // is enforced here (INV-29).
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, COST_CENTER_EDITORS);
  const now = new Date();
  // cost.cost_centers is org_only, so the org-scoped tenant transaction is the
  // fence; one row per (org, label) for ever makes a re-add a restore.
  const row = await withTenantDb(async (tx) => {
    const [existing] = await tx
      .select()
      .from(centers)
      .where(and(eq(centers.orgId, ctx.orgId), eq(centers.label, input.label)))
      .limit(1);
    if (existing && existing.deletedAt === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "cost_center_exists",
        message: `The cost center ${existing.label} is already on the list`,
      });
    }
    if (existing) {
      const [restored] = await tx
        .update(centers)
        .set({
          deletedAt: null,
          deletedById: null,
          description: input.description ?? existing.description,
          updatedAt: now,
          updatedById: userId,
        })
        .where(eq(centers.id, existing.id))
        .returning();
      return restored;
    }
    const [inserted] = await tx
      .insert(centers)
      .values({
        orgId: ctx.orgId,
        label: input.label,
        description: input.description ?? null,
        createdById: userId,
        updatedById: userId,
      })
      .returning();
    return inserted;
  }).catch((err: unknown) => {
    // Two creates of one label can both read no row and both insert. The
    // unique index turns the second insert into a 23505, which aborts its
    // transaction, so the conflict is answered here, outside it.
    if (isUniqueViolation(err, "cost_centers_org_label_idx")) {
      throw new HandlerError({
        code: "conflict",
        reason: "cost_center_exists",
        message: `The cost center ${input.label} is already on the list`,
      });
    }
    throw err;
  });
  if (!row) throw new Error("create_cost_center: the label was not stored");
  return { costCenter: toCostCenter(row, { agents: 0, workspaces: 0 }) };
};
