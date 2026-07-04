"use server";
import "@oxagen/handlers/register";
// agent.* capabilities (approval.resolve, plan.approve, task.background.*) are
// supplied by a separate package; its register module must run to bind them
// into the kernel before any invoke() here. Without it the kernel throws
// "No handler registered for capability agent.approval.resolve".
import "@oxagen/agent/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type { DbMessageRow, ConversationRow } from "@oxagen/database";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { agentMcpConsentResolve } from "@oxagen/oxagen/contracts/agent.mcp.consent.resolve";
import { agentPlanApprove } from "@oxagen/oxagen/contracts/agent.plan.approve";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/contracts/agent.task.background.cancel";
import { agentTaskBackgroundRead } from "@oxagen/oxagen/contracts/agent.task.background.read";
import { invoke } from "@oxagen/oxagen";
import type { PlanStep } from "@/components/chat/stream-event-types";
import type { BackgroundTaskSnapshot } from "@/components/chat/background-task-tray";
import { getSessionOrRedirect } from "@/lib/session";
import { assertWorkspaceMember } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

const FormSchema = z.object({
  content: z.string().min(1),
  conversationId: z.string().nullable().default(null),
  parentMessageId: z.string().nullable().default(null),
  branchReason: z.enum(["edit", "regenerate", "tool_retry", "manual_fork"]).nullable().default(null),
});

// Implements the spec §6.9 DAG: persist the user message under the active
// leaf and shift the conversation's active_leaf forward. The LLM call and
// streaming live in the stream route (POST /api/v1/chat/stream), which is
// the SINGLE LLM caller per turn (OXA-1509) and persists the matching
// assistant reply itself once the stream finishes. This action returns the
// conversation id and the new user-message id so the client can start the
// stream against them (the stream route threads the assistant reply under
// the user message and into the same conversation).
//
// Token usage is recorded by ClickHouse from @oxagen/ai's streamAgentReply
// onFinish — the app does not write ClickHouse directly (§3 boundary).
export async function sendMessageAction(
  ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
  formData: FormData,
): Promise<
  | { ok: true; conversationId: string; conversationPublicId: string; userMessageId: string }
  | { ok: false; error: string }
> {
  const session = await getSessionOrRedirect();
  // invoke() from apps/app skips kernel IAM, and ctx.orgId/workspaceId arrive
  // from the (client-controlled) action arguments — assert the caller actually
  // belongs to this workspace or a session scoped to workspace A could send
  // messages into (and bill) workspace B by passing its ids. notFound() on miss.
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  const raw = Object.fromEntries(formData);
  const parsed = FormSchema.safeParse({
    content: raw.content,
    conversationId: raw.conversationId ? String(raw.conversationId) : null,
    parentMessageId: raw.parentMessageId ? String(raw.parentMessageId) : null,
    branchReason: raw.branchReason ? String(raw.branchReason) : null,
  });
  if (!parsed.success) return { ok: false, error: "Invalid message" };

  // The composer serializes already-uploaded attachments (publicId refs only
  // — never inline bytes) as a JSON `attachments` field. Absent/malformed
  // input parses to [] via chatMessageSend's schema default below, EXCEPT a
  // present-but-unparsable JSON string, which fails fast here.
  let rawAttachments: unknown = [];
  if (typeof raw.attachments === "string" && raw.attachments.length > 0) {
    try {
      rawAttachments = JSON.parse(raw.attachments);
    } catch {
      return { ok: false, error: "Invalid attachments" };
    }
  }

  const capabilityInput = chatMessageSend.input.safeParse({
    conversationId: parsed.data.conversationId,
    parentMessageId: parsed.data.parentMessageId,
    branchReason: parsed.data.branchReason,
    content: parsed.data.content,
    contentBlocks: [],
    attachments: rawAttachments,
  });
  if (!capabilityInput.success) return { ok: false, error: capabilityInput.error.issues[0]?.message ?? "Invalid" };

  return await runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
    try {
      const { conversationId, conversationPublicId, userMessageId } = await withTenantDb(async (tx) => {
        // Resolve or create the conversation. For an existing conversation we
        // also read its CURRENT active leaf (server-authoritative threading) and
        // verify it belongs to this org/workspace (no cross-tenant IDOR).
        let convId: string;
        let convPublicId: string;
        let currentLeaf: string | null;
        if (capabilityInput.data.conversationId) {
          const [existing] = await tx
            .select({
              id: schema.conversations.id,
              publicId: schema.conversations.publicId,
              leaf: schema.conversations.activeLeafMessageId,
            })
            .from(schema.conversations)
            .where(
              and(
                eq(schema.conversations.id, capabilityInput.data.conversationId),
                eq(schema.conversations.orgId, ctx.orgId),
                eq(schema.conversations.workspaceId, ctx.workspaceId),
              ),
            )
            .limit(1);
          if (!existing) throw new Error("Conversation not found");
          convId = existing.id;
          convPublicId = existing.publicId;
          currentLeaf = existing.leaf ?? null;
        } else {
          const [conv] = await tx
            .insert(schema.conversations)
            .values({
              orgId: ctx.orgId,
              workspaceId: ctx.workspaceId,
              userId: session.user.id,
              status: "active",
              createdByUserId: session.user.id,
              updatedByUserId: session.user.id,
            })
            .returning();
          if (!conv) throw new Error("Conversation insert failed");
          const typedConv = conv as ConversationRow;
          convId = typedConv.id;
          convPublicId = typedConv.publicId;
          currentLeaf = null;
        }

        // Thread the user message onto the conversation's CURRENT active leaf
        // (read fresh above) — NOT the client-supplied parentMessageId, which
        // lags the DB across turns: the composer's parent prop trails the user
        // message while the real leaf has already advanced to the assistant
        // reply, so mis-parenting silently drops every assistant reply from the
        // visible branch (walkActiveBranch walks parent links from the leaf). An
        // explicit branch op (edit/regenerate/…) is the only case that overrides
        // the parent with a client-chosen branch point.
        const parentMessageId =
          parsed.data.branchReason && capabilityInput.data.parentMessageId
            ? capabilityInput.data.parentMessageId
            : currentLeaf;

        const [userMsg] = await tx
          .insert(schema.messages)
          .values({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            conversationId: convId,
            parentMessageId: parentMessageId ?? undefined,
            role: "user",
            content: capabilityInput.data.content,
            contentBlocks: capabilityInput.data.contentBlocks,
            branchReason: capabilityInput.data.branchReason ?? undefined,
            isActiveInBranch: true,
            // Attachment refs (publicId only) ride on metadata rather than
            // contentBlocks — message-bubble.tsx renders them from
            // messages.metadata.attachments (see attachment-chip.tsx's
            // ConversationAttachmentRef), and the chat stream route/history.ts
            // resolve them server-side to build multimodal model input.
            metadata:
              capabilityInput.data.attachments.length > 0
                ? { attachments: capabilityInput.data.attachments }
                : {},
            createdByUserId: session.user.id,
            updatedByUserId: session.user.id,
          })
          .returning();
        if (!userMsg) throw new Error("Message insert failed");
        const typedMsg = userMsg as DbMessageRow;

        await tx
          .update(schema.conversations)
          .set({ activeLeafMessageId: typedMsg.id, updatedAt: new Date() })
          .where(eq(schema.conversations.id, convId));

        return { conversationId: convId, conversationPublicId: convPublicId, userMessageId: typedMsg.id };
      });

      revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/ask`);
      return { ok: true, conversationId, conversationPublicId, userMessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send message";
      return { ok: false, error: message };
    }
  });
}

// Capability-dispatch helpers for the chat UI. All capability calls go
// through kernel.invoke() per the enforced path (OXA-1498).
function capabilityContext(ctx: {
  orgId: string;
  workspaceId: string;
  userId: string;
  surface?: "app";
}) {
  // The chat UI runs server actions inside the user session, so apiKeyId
  // is always null and we mint a per-call requestId for trace correlation.
  // ctx.surface records the request *origin* ("app" — these run as Next
  // server actions); the capability *exposure* surface ("agent") is passed
  // separately to invoke()'s opts and is enforced against the contract's
  // `surfaces` allowlist. The two are intentionally different axes
  // (CapabilityContext.surface vs CapabilitySurface) — see packages/oxagen
  // types.ts — so "agent" is deliberately not a valid origin here.
  return {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: (ctx.surface ?? "app") as "app",
    messageId: null as string | null,
  };
}

export async function resolveApprovalAction(
  ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
  approvalId: string,
  decision: "approved" | "denied",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  const parsed = agentApprovalResolve.input.safeParse({ approvalId, decision });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "agent.approval.resolve",
      parsed.data,
      capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/ask`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to resolve approval" };
  }
}

export async function resolveConsentAction(
  ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
  approvalId: string,
  decision: "granted" | "denied",
  grantAllTools: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  const parsed = agentMcpConsentResolve.input.safeParse({ approvalId, decision, grantAllTools });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "agent.mcp.consent.resolve",
      parsed.data,
      capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/ask`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to resolve consent" };
  }
}

export async function resolvePlanAction(
  ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
  planId: string,
  decision: "approved" | "denied" | "amended",
  amendedSteps?: PlanStep[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  // The capability speaks `approve | deny | amend` (verb), the UI speaks
  // `approved | denied | amended` (past tense). Map between them.
  const verbMap: Record<typeof decision, "approve" | "deny" | "amend"> = {
    approved: "approve",
    denied: "deny",
    amended: "amend",
  };
  const parsed = agentPlanApprove.input.safeParse({
    planId,
    decision: verbMap[decision],
    amendedSteps: amendedSteps?.map((s) => ({
      id: s.id,
      summary: s.summary,
      intent: s.intent,
      capability: s.capability,
      inputPreview: s.inputPreview ?? null,
      dependsOn: s.dependsOn,
    })),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "agent.plan.approve",
      parsed.data,
      capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/ask`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to resolve plan" };
  }
}

export async function cancelBackgroundTaskAction(
  ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
  taskId: string,
  reason?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  const parsed = agentTaskBackgroundCancel.input.safeParse({ taskId, reason });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "agent.task.background.cancel",
      parsed.data,
      capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/ask`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel task" };
  }
}

export async function readBackgroundTaskAction(
  ctx: { orgId: string; workspaceId: string },
  taskId: string,
): Promise<BackgroundTaskSnapshot> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  try {
    const parsed = agentTaskBackgroundRead.input.safeParse({ taskId });
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "Invalid task id");
    }
    const out = await invoke(
      "agent.task.background.read",
      parsed.data,
      capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
      { surface: "agent" },
    ) as import("@oxagen/oxagen/contracts/agent.task.background.read").AgentTaskBackgroundReadOutput;
    return {
      taskId: out.taskId,
      kind: out.kind,
      label: out.label,
      status: out.status,
      createdAt: out.createdAt,
      startedAt: out.startedAt,
      completedAt: out.completedAt,
      failureReason: out.failureReason,
    };
  } catch (err) {
    // The poller (background-task-tray) calls this inside Promise.allSettled
    // and silently drops rejected results, freezing the row forever at its
    // last known state. Instead of letting the failure vanish, log it with
    // context and surface a terminal "failed" snapshot so the user sees the
    // real outcome and polling stops.
    const failureReason = err instanceof Error ? err.message : "Failed to read task status";
    logger.error(
      { err, taskId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "[ask] readBackgroundTaskAction failed",
    );
    return {
      taskId,
      kind: "unknown",
      label: null,
      status: "failed",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: new Date().toISOString(),
      failureReason,
    };
  }
}
