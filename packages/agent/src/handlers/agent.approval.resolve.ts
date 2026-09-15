// resolve_approval — the human decision on a paused tool call, and the one
// rev1 write ADR-052 bills (apps/app/ARCHITECTURE.md §1.5).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, or workspace Owner or
//      Member (the contract's defaultRoles), for the signed-in user or the
//      creator of the API key (resolveActingUserId). The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler checks.
//   2. One UPDATE that matches the row by either id form (#2906), inside the
//      caller's org and workspace, only while it is unexpired and unresolved.
//   3. A matched row writes the approval.resolved feed row for the person
//      whose message parked the call, in the same transaction.
//   4. No row matched → HandlerError conflict `approval_expired`. The throw
//      leaves through the kernel's catch, so the usage recorder never runs and
//      the no-op is not a governed action (§3.9 item 15).

import { withTenantDb, schema } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { notifyResolution } from "../runtime/approval";
import { APPROVAL_RESOLVER_ROLES } from "../runtime/approval-roles";
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
    APPROVAL_RESOLVER_ROLES,
  );

  // `approvalId` arrives as the public id (apr_…) or the row uuid (#2906).
  // Reject expired rows atomically: WHERE expires_at > now() guards
  // against a late approver winning the race.
  const row = await withTenantDb(async (tx) => {
    const [matched] = await tx
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
      .returning({
        id: schema.approvalRequests.id,
        messageId: schema.approvalRequests.messageId,
        capabilityName: schema.approvalRequests.capabilityName,
      });
    if (!matched) return null;

    // MC spec §7.7 approval.resolved: the person whose message parked the
    // call hears the decision, written with the decision. A person who
    // resolves their own approval already knows.
    const [requester] = await tx
      .select({ userId: schema.conversations.userId })
      .from(schema.messages)
      .innerJoin(
        schema.conversations,
        eq(schema.conversations.id, schema.messages.conversationId),
      )
      .where(
        and(
          eq(schema.messages.id, matched.messageId),
          eq(schema.messages.orgId, ctx.orgId),
          eq(schema.messages.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);
    if (requester && requester.userId !== actingUserId) {
      await tx.insert(schema.notifications).values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: requester.userId,
        kind: "approval",
        event: "approval.resolved",
        title: `Approval ${input.decision}: ${matched.capabilityName}`,
        body: input.note ?? null,
        deepLink: null,
      });
    }
    return matched;
  });

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
