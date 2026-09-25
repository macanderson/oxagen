// `delete_cost_center` (ADR-142): soft-delete a label. The row stays, so past
// statements still name it; the rollup stops charging new runs to it. Governed
// by the kernel's capability.invoke_* audit; no domain event type fits.
//
// Every agent and workspace that names the label is cleared as part of the
// delete (#3750). A label left on them would still show in `list_workspaces`
// and on the agents page as if it were live, and `create_cost_center` on the
// same label would bring every one of those assignments back.
//
// `agent.agents` is a standard table, so an org-wide transaction can read its
// rows in every workspace but can write none of them (ADR-086). The agents are
// therefore cleared one workspace at a time, each in that workspace's own
// scope, before the label and the workspaces are cleared together in the last
// transaction. A failure part way leaves the label on the list with some
// agents already cleared, and calling the delete again finishes the job.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import type { costCenterDelete } from "@oxagen/oxagen/contracts/cost_center.delete";
import { schema, withOrgDb, withTenantDb, type Tx } from "@oxagen/database";
import { getPrincipalAttribution, runInTenantScope } from "@oxagen/tenancy";
import { and, eq, sql, type AnyColumn } from "drizzle-orm";
import { COST_CENTER_EDITORS } from "./cost_center.create";
import { readLiveCostCenter } from "./cost_center.shared";
import { logger } from "./logger";

async function requireLive(tx: Tx, orgId: string, label: string) {
  const live = await readLiveCostCenter(tx, orgId, label);
  if (!live) {
    throw new HandlerError({
      code: "not_found",
      reason: "cost_center_not_found",
      message: `No cost center ${label} is on the list`,
    });
  }
  return live;
}

/** A stored label matches the list's label ignoring case, as the list's unique index does. */
function names(column: AnyColumn, label: string) {
  return sql`lower(${column}) = lower(${label})`;
}

export const costCenterDeleteHandler: CapabilityHandler<
  typeof costCenterDelete
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, COST_CENTER_EDITORS);
  const now = new Date();
  // The workspaces that hold an agent naming the label. Deleted agents count
  // too, so restoring one does not bring the label back with it.
  const { label, agentWorkspaces } = await withOrgDb(async (tx) => {
    const live = await requireLive(tx, ctx.orgId, input.label);
    const rows = await tx
      .select({ workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, ctx.orgId),
          names(schema.agents.costCenter, live.label),
        ),
      )
      .groupBy(schema.agents.workspaceId);
    return {
      label: live.label,
      agentWorkspaces: rows.map((r) => r.workspaceId),
    };
  });
  let agentsCleared = 0;
  for (const workspaceId of agentWorkspaces) {
    const cleared = await runInTenantScope(
      { ...getPrincipalAttribution(), orgId: ctx.orgId, workspaceId },
      () =>
        withTenantDb((tx) =>
          tx
            .update(schema.agents)
            .set({ costCenter: null, updatedAt: now, updatedById: userId })
            .where(
              and(
                eq(schema.agents.orgId, ctx.orgId),
                eq(schema.agents.workspaceId, workspaceId),
                names(schema.agents.costCenter, label),
              ),
            )
            .returning({ id: schema.agents.id }),
        ),
    );
    agentsCleared += cleared.length;
  }
  const { row, workspacesCleared } = await withTenantDb(async (tx) => {
    const live = await requireLive(tx, ctx.orgId, label);
    // `workspace.workspaces` is org_only, so one statement reaches every
    // workspace in the organization, archived ones included.
    const workspaces = await tx
      .update(schema.workspaces)
      .set({ costCenter: null, updatedAt: now, updatedById: userId })
      .where(
        and(
          eq(schema.workspaces.orgId, ctx.orgId),
          names(schema.workspaces.costCenter, live.label),
        ),
      )
      .returning({ id: schema.workspaces.id });
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
    return { row: deleted, workspacesCleared: workspaces.length };
  });
  if (!row?.deletedAt)
    throw new Error("delete_cost_center: the label was not deleted");
  logger.info(
    {
      orgId: ctx.orgId,
      label: row.label,
      agentsCleared,
      workspacesCleared,
    },
    "delete_cost_center: label deleted and cleared from agents and workspaces",
  );
  return { label: row.label, deletedAt: row.deletedAt.toISOString() };
};
