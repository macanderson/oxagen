import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentFanoutListInput,
  AgentSubagentFanoutListOutput,
} from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";

export type { AgentSubagentFanoutListInput, AgentSubagentFanoutListOutput };

// Read the most recent fan-outs for the active workspace so the in-app viewer
// can list what the agent dispatched. Tenant scope is enforced both by
// withTenantDb (RLS) and explicit org/workspace predicates — defence in depth.
export async function agentSubagentFanoutListHandler(
  input: AgentSubagentFanoutListInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentFanoutListOutput> {
  const limit = input.limit ?? 50;

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentFanouts.publicId,
        parentMessageId: schema.subagentFanouts.parentMessageId,
        status: schema.subagentFanouts.status,
        totalChildren: schema.subagentFanouts.totalChildren,
        completedChildren: schema.subagentFanouts.completedChildren,
        createdAt: schema.subagentFanouts.createdAt,
        updatedAt: schema.subagentFanouts.updatedAt,
      })
      .from(schema.subagentFanouts)
      .where(
        and(
          eq(schema.subagentFanouts.orgId, ctx.orgId),
          eq(schema.subagentFanouts.workspaceId, ctx.workspaceId),
          input.parentMessageId
            ? eq(schema.subagentFanouts.parentMessageId, input.parentMessageId)
            : undefined,
        ),
      )
      .orderBy(desc(schema.subagentFanouts.createdAt))
      .limit(limit),
  );

  return {
    fanouts: rows.map((r) => ({
      fanoutId: r.publicId,
      parentMessageId: r.parentMessageId,
      status:
        r.status as AgentSubagentFanoutListOutput["fanouts"][number]["status"],
      totalChildren: r.totalChildren,
      completedChildren: r.completedChildren,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}
