// `record_reply_feedback` (#4169): a person's verdict on one assistant reply,
// appended to ClickHouse `assistant_reply_feedback` against the run the reply
// was recorded as.
//
// Before it writes, the handler proves three things in Postgres, each read
// scoped to this organization and workspace:
//
// 1. The run is an assistant run here: `agent_runs` holds it on one of the two
//    in-app surfaces (`chat`, `api-chat`). A mandate run or a wrapped session
//    takes no verdict here.
// 2. The conversation is the caller's own and not deleted. Nobody records a
//    verdict on someone else's turn.
// 3. That conversation holds the assistant message the run wrote
//    (`metadata.runId`, set by `appendAssistantMessage` in @oxagen/agent). The
//    message id comes from here, never from the caller.
//
// A failure of any of the three is one `not_found`, so the answer says nothing
// about whether a run exists in another person's conversation.
//
// The role gate runs here, as it does for `ask_assistant`, because the
// kernel's IAM check allows every capability for a non-enterprise organization
// (INV-29). An API-key call votes as the key's creator.
//
// audit-exempt: the kernel's capability.invoke_* row records who rated which
// run. A verdict grants, revokes, and spends nothing, and the taxonomy has no
// event for it.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  assistantReplyFeedbackRecord,
  type AssistantReplyFeedbackRecordOutput,
} from "@oxagen/oxagen/contracts/assistant.reply_feedback.record";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.list";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { recordReplyFeedback } from "@oxagen/telemetry";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";

/** The roles the contract grants, as the names `assertOrgRole` takes. */
const FEEDBACK_ROLES = {
  org: allowedRoles(assistantReplyFeedbackRecord.defaultRoles.org),
  workspace: allowedRoles(assistantReplyFeedbackRecord.defaultRoles.workspace),
};

function allowedRoles(grants: Record<string, string | undefined>): string[] {
  return Object.entries(grants)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

export const assistantReplyFeedbackRecordHandler: CapabilityHandler<
  typeof assistantReplyFeedbackRecord
> = async (input, ctx): Promise<AssistantReplyFeedbackRecordOutput> => {
  const actingUserId = await resolveActingUserId(ctx);
  if (actingUserId === null) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }
  await assertOrgRole({ ...ctx, userId: actingUserId }, FEEDBACK_ROLES);

  const reply = await withTenantDb(async (tx) => {
    const [run] = await tx
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.publicId, input.runId),
          eq(schema.agentRuns.orgId, ctx.orgId),
          eq(schema.agentRuns.workspaceId, ctx.workspaceId),
          inArray(schema.agentRuns.surface, [...IN_APP_AGENT_SURFACES]),
        ),
      )
      .limit(1);
    if (!run) return null;

    const [conversation] = await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, input.conversationId),
          eq(schema.conversations.orgId, ctx.orgId),
          eq(schema.conversations.workspaceId, ctx.workspaceId),
          eq(schema.conversations.userId, actingUserId),
          isNull(schema.conversations.deletedAt),
        ),
      )
      .limit(1);
    if (!conversation) return null;

    const [message] = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversation.id),
          eq(schema.messages.orgId, ctx.orgId),
          eq(schema.messages.workspaceId, ctx.workspaceId),
          eq(schema.messages.role, "assistant"),
          sql`${schema.messages.metadata}->>'runId' = ${input.runId}`,
        ),
      )
      .limit(1);
    return message ?? null;
  });

  if (reply === null) {
    logger.warn(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        runId: input.runId,
        conversationId: input.conversationId,
      },
      "record_reply_feedback: refused, no assistant reply for this run in the caller's conversation",
    );
    throw new HandlerError({
      code: "not_found",
      reason: "assistant_reply_not_found",
      message:
        "No assistant reply recorded as this run sits in your conversation in this workspace.",
    });
  }

  const recordedAt = new Date().toISOString();
  await recordReplyFeedback({
    run_public_id: input.runId,
    conversation_id: input.conversationId,
    message_id: reply.id,
    user_id: actingUserId,
    verdict: input.verdict,
    note: input.note ?? "",
    created_at: recordedAt,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId: input.runId,
      verdict: input.verdict,
      hasNote: input.note !== null,
      surface: ctx.surface,
    },
    "record_reply_feedback: recorded",
  );

  return {
    runId: input.runId,
    conversationId: input.conversationId,
    messageId: reply.id,
    verdict: input.verdict,
    note: input.note,
    recordedAt,
  };
};
