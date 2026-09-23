// `set_cost_center` (ADR-142): charge the active workspace, or one agent in
// it, back to a live label, or clear it. The label is checked against the
// organization's list here, since the column has no cross-schema FK. Governed
// by the kernel's capability.invoke_* audit; no domain event type fits.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import type { costCenterSet } from "@oxagen/oxagen/contracts/cost_center.set";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { COST_CENTER_EDITORS } from "./cost_center.create";
import { readLiveCostCenter } from "./cost_center.shared";

export const costCenterSetHandler: CapabilityHandler<
  typeof costCenterSet
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, COST_CENTER_EDITORS);
  const now = new Date();
  return withTenantDb(async (tx) => {
    // The list's spelling is what gets stored, so `eng-1001` typed on an
    // agent reads as the list's `ENG-1001` everywhere after.
    let label: string | null = null;
    if (input.costCenter !== null) {
      const live = await readLiveCostCenter(tx, ctx.orgId, input.costCenter);
      if (!live) {
        throw new HandlerError({
          code: "not_found",
          reason: "cost_center_not_found",
          message: `No cost center ${input.costCenter} is on the organization's list`,
        });
      }
      label = live.label;
    }
    if (input.target === "workspace") {
      const [row] = await tx
        .update(schema.workspaces)
        .set({ costCenter: label, updatedAt: now, updatedById: userId })
        .where(
          and(
            eq(schema.workspaces.id, ctx.workspaceId),
            eq(schema.workspaces.orgId, ctx.orgId),
          ),
        )
        .returning({ id: schema.workspaces.publicId });
      if (!row) {
        throw new HandlerError({
          code: "not_found",
          reason: "workspace_not_found",
          message: "The workspace is not in this organization",
        });
      }
      return { target: "workspace" as const, id: row.id, costCenter: label };
    }
    const slug = input.agent ?? "";
    const [row] = await tx
      .update(schema.agents)
      .set({ costCenter: label, updatedAt: now, updatedById: userId })
      .where(
        and(
          eq(schema.agents.orgId, ctx.orgId),
          eq(schema.agents.workspaceId, ctx.workspaceId),
          eq(schema.agents.slug, slug),
          isNull(schema.agents.deletedAt),
        ),
      )
      .returning({ id: schema.agents.publicId });
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `No agent ${slug} is in this workspace`,
      });
    }
    return { target: "agent" as const, id: row.id, costCenter: label };
  });
};
