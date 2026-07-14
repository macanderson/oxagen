import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentPlanListInput,
  AgentPlanListOutput,
} from "@oxagen/oxagen/contracts/agent.plan.list";

export type { AgentPlanListInput, AgentPlanListOutput };

export async function agentPlanListHandler(
  input: AgentPlanListInput,
  _ctx: CapabilityContext,
): Promise<AgentPlanListOutput> {
  const filters: SQL[] = [];
  if (input.status) filters.push(eq(schema.agentPlans.status, input.status));
  // Keyset pagination on createdAt (newest first): the cursor is the previous
  // page's last createdAt, so fetch strictly older rows.
  if (input.cursor) {
    const cursorDate = new Date(input.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      filters.push(lt(schema.agentPlans.createdAt, cursorDate));
    }
  }

  // Over-fetch by one to detect whether another page exists. RLS scopes rows to
  // the caller's org+workspace.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.agentPlans.publicId,
        status: schema.agentPlans.status,
        goals: schema.agentPlans.goals,
        approvalRequired: schema.agentPlans.approvalRequired,
        approvedAt: schema.agentPlans.approvedAt,
        taskCount: schema.agentPlans.taskCount,
        createdAt: schema.agentPlans.createdAt,
      })
      .from(schema.agentPlans)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(schema.agentPlans.createdAt))
      .limit(input.limit + 1),
  );

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return {
    plans: page.map((row) => ({
      planId: row.publicId,
      status: row.status,
      goals: (row.goals as string[]) ?? [],
      approvalRequired: row.approvalRequired,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      taskCount: row.taskCount,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor,
  };
}
