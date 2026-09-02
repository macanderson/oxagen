import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { notifyResolution } from "../runtime/approval";
import type {
  AgentApprovalResolveInput,
  AgentApprovalResolveOutput,
} from "@oxagen/oxagen/contracts/agent.approval.resolve";

export type { AgentApprovalResolveInput, AgentApprovalResolveOutput };

export async function agentApprovalResolveHandler(
  input: AgentApprovalResolveInput,
  ctx: CapabilityContext,
): Promise<AgentApprovalResolveOutput> {
  // Reject expired rows atomically: WHERE expires_at > now() guards
  // against a late approver winning the race.
  const updated = await withTenantDb((tx) =>
    tx
      .update(schema.approvalRequests)
      .set({
        resolution: input.decision,
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
        note: input.note ?? null,
      })
      .where(
        and(
          eq(schema.approvalRequests.id, input.approvalId),
          eq(schema.approvalRequests.orgId, ctx.orgId),
          eq(schema.approvalRequests.workspaceId, ctx.workspaceId),
          sql`${schema.approvalRequests.expiresAt} > now()`,
          sql`${schema.approvalRequests.resolution} IS NULL`,
        ),
      )
      .returning({ id: schema.approvalRequests.id }),
  );

  const resolution: "approved" | "denied" | "expired" =
    updated.length === 0 ? "expired" : input.decision;

  await notifyResolution({
    approvalId: input.approvalId,
    resolution,
    note: input.note ?? null,
  });
  return { approvalId: input.approvalId, resolution };
}
