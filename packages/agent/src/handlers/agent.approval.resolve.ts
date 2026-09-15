// resolve_approval — the human decision on a paused tool call, and the one
// rev1 write ADR-052 bills (apps/app/ARCHITECTURE.md §1.5).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, or workspace Owner or
//      Member (the contract's defaultRoles), for the signed-in user or the
//      creator of the API key (resolveActingUserId). The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler checks.
//   2. One UPDATE that matches the row by either id form (#2906), inside the
//      caller's org and workspace, only while it is unexpired and unresolved.
//   3. No row matched → HandlerError conflict `approval_expired`. The throw
//      leaves through the kernel's catch, so the usage recorder never runs and
//      the no-op is not a governed action (§3.9 item 15).

import { withTenantDb, schema } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { notifyResolution } from "../runtime/approval";
import { approvalIdCondition } from "../runtime/approval-id";
import type {
  AgentApprovalResolveInput,
  AgentApprovalResolveOutput,
} from "@oxagen/oxagen/contracts/agent.approval.resolve";

export type { AgentApprovalResolveInput, AgentApprovalResolveOutput };

export async function agentApprovalResolveHandler(
  input: AgentApprovalResolveInput,
  ctx: CapabilityContext,
): Promise<AgentApprovalResolveOutput> {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
  );

  // `approvalId` arrives as the public id (apr_…) or the row uuid (#2906).
  // Reject expired rows atomically: WHERE expires_at > now() guards
  // against a late approver winning the race.
  const updated = await withTenantDb((tx) =>
    tx
      .update(schema.approvalRequests)
      .set({
        resolution: input.decision,
        resolvedAt: new Date(),
        resolvedByUserId: actingUserId,
        note: input.note ?? null,
      })
      .where(
        and(
          approvalIdCondition(input.approvalId),
          eq(schema.approvalRequests.orgId, ctx.orgId),
          eq(schema.approvalRequests.workspaceId, ctx.workspaceId),
          sql`${schema.approvalRequests.expiresAt} > now()`,
          sql`${schema.approvalRequests.resolution} IS NULL`,
        ),
      )
      .returning({ id: schema.approvalRequests.id }),
  );

  const row = updated[0];
  if (!row) {
    throw new HandlerError({
      code: "conflict",
      reason: "approval_expired",
      message: "The approval is not pending in this workspace",
    });
  }

  // Waiters are keyed by the row uuid (createApprovalRequest returns it), so
  // notify with the uuid from RETURNING, never with the caller's id form.
  await notifyResolution({
    approvalId: row.id,
    resolution: input.decision,
    note: input.note ?? null,
  });
  return { approvalId: input.approvalId, resolution: input.decision };
}
