import { schema, withTenantDb } from "@oxagen/database";
import { inputDigest } from "@oxagen/rules";
import { notifyApprovalRequested } from "@oxagen/rules/approval-notify";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { resolveRunPublicId } from "./approval";
import { ApprovalResumeError } from "./approval-resume-payload";

/** Recover a single-use approval across turns in the requesting conversation. */
export async function externalApproval(args: {
  orgId: string;
  workspaceId: string;
  userId: string;
  messageId: string;
  capabilityName: string;
  input: unknown;
  approvalDigest: string;
  runId?: string | null;
}) {
  return withTenantDb(async (tx) => {
    const message = await tx.query.messages.findFirst({
      where: and(
        eq(schema.messages.id, args.messageId),
        eq(schema.messages.orgId, args.orgId),
        eq(schema.messages.workspaceId, args.workspaceId),
      ),
    });
    const conversation =
      message &&
      (await tx.query.conversations.findFirst({
        where: and(
          eq(schema.conversations.id, message.conversationId),
          eq(schema.conversations.orgId, args.orgId),
          eq(schema.conversations.workspaceId, args.workspaceId),
          eq(schema.conversations.userId, args.userId),
        ),
      }));
    if (!conversation)
      throw new ApprovalResumeError("requester_conversation_missing");
    // The gate digest binds the input, current rules, requester, and tenant.
    // The conversation prevents a different task from spending this proof.
    const resumeKey = `external:${inputDigest({
      conversationId: conversation.id,
      approvalDigest: args.approvalDigest,
    })}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${resumeKey}, 0))`,
    );
    const a = schema.approvalRequests;
    const scope = and(
      eq(a.orgId, args.orgId),
      eq(a.workspaceId, args.workspaceId),
      eq(a.capabilityName, args.capabilityName),
      eq(a.resumeKey, resumeKey),
      gt(a.expiresAt, new Date()),
    );
    const existing = await tx.query.approvalRequests.findFirst({
      where: scope,
    });
    if (existing) {
      if (existing.resolution === "approved" && !existing.tokenUsedAt) {
        // Consume before returning proof. Concurrent retries cannot both run.
        const [claimed] = await tx
          .update(a)
          .set({ tokenUsedAt: new Date() })
          .where(
            and(
              scope,
              eq(a.id, existing.id),
              eq(a.resolution, "approved"),
              isNull(a.tokenUsedAt),
            ),
          )
          .returning({ id: a.id });
        if (claimed)
          return {
            approvalId: existing.id,
            expiresAt: existing.expiresAt,
            status: "approved" as const,
          };
      }
      return {
        approvalId: existing.id,
        expiresAt: existing.expiresAt,
        status:
          existing.resolution === null
            ? ("pending" as const)
            : ("refused" as const),
      };
    }
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const [row] = await tx
      .insert(a)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        messageId: args.messageId,
        capabilityName: args.capabilityName,
        inputPreview: args.input as object,
        inputDigest: inputDigest(args.input),
        riskLevel: "high",
        expiresAt,
        resumeKey,
        runPublicId: await resolveRunPublicId(tx, args),
      })
      .returning({ approvalId: a.id });
    if (!row) throw new ApprovalResumeError("approval_not_recorded");
    await notifyApprovalRequested(tx, {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      capabilityName: args.capabilityName,
      riskLevel: "high",
      expiresAt,
    });
    return { ...row, expiresAt, status: "pending" as const };
  });
}
