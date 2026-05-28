"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { chatMessageSend } from "@oxagen/oxagen/capabilities/chat.message.send";
import { agentApprovalResolve } from "@oxagen/oxagen/capabilities/agent.approval.resolve";
import { agentPlanApprove } from "@oxagen/oxagen/capabilities/agent.plan.approve";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/capabilities/agent.task.background.cancel";
import { agentTaskBackgroundRead } from "@oxagen/oxagen/capabilities/agent.task.background.read";
import { agentApprovalResolveHandler } from "@oxagen/agent/handlers/agent.approval.resolve";
import { agentPlanApproveHandler } from "@oxagen/agent/handlers/agent.plan.approve";
import { agentTaskBackgroundCancelHandler } from "@oxagen/agent/handlers/agent.task.background.cancel";
import { agentTaskBackgroundReadHandler } from "@oxagen/agent/handlers/agent.task.background.read";
import { streamAgentReply, defaultModel } from "@oxagen/ai";
import { materializeTools } from "@oxagen/agent";
import { randomUUID } from "node:crypto";
import type { CoreMessage } from "ai";
import type { PlanStep } from "@/components/chat/stream-event-types";
import type { BackgroundTaskSnapshot } from "@/components/chat/background-task-tray";
import { getSessionOrRedirect } from "@/lib/session";

const FormSchema = z.object({
  content: z.string().min(1),
  conversationId: z.string().nullable().default(null),
  parentMessageId: z.string().nullable().default(null),
  branchReason: z.enum(["edit", "regenerate", "tool_retry", "manual_fork"]).nullable().default(null),
});

// Implements the spec §6.9 DAG: append the user message under the active
// leaf, stream an assistant reply, persist it as the next node, and shift
// the conversation's active_leaf forward. Token usage is recorded by
// ClickHouse from apps/api once the runner observes the row — the app
// does not write ClickHouse directly (§3 boundary).
export async function sendMessageAction(
  ctx: { tenantSlug: string; workspaceSlug: string; tenantId: string; workspaceId: string },
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  const raw = Object.fromEntries(formData);
  const parsed = FormSchema.safeParse({
    content: raw.content,
    conversationId: raw.conversationId ? String(raw.conversationId) : null,
    parentMessageId: raw.parentMessageId ? String(raw.parentMessageId) : null,
    branchReason: raw.branchReason ? String(raw.branchReason) : null,
  });
  if (!parsed.success) return { ok: false, error: "Invalid message" };

  const capabilityInput = chatMessageSend.input.safeParse({
    conversationId: parsed.data.conversationId,
    agentVersionId: null,
    parentMessageId: parsed.data.parentMessageId,
    branchReason: parsed.data.branchReason,
    content: parsed.data.content,
    contentBlocks: [],
  });
  if (!capabilityInput.success) return { ok: false, error: capabilityInput.error.issues[0]?.message ?? "Invalid" };

  const tables = schema as unknown as Record<string, any>;
  if (!tables.conversations || !tables.messages) {
    return { ok: false, error: "Chat tables not migrated yet" };
  }

  try {
    const { conversationId, userMessageId, priorMessages } = await db().transaction(async (tx) => {
      let convId = capabilityInput.data.conversationId;
      if (!convId) {
        const [conv] = await tx
          .insert(tables.conversations)
          .values({
            tenantId: ctx.tenantId,
            workspaceId: ctx.workspaceId,
            userId: session.user.id,
            status: "active",
            createdByUserId: session.user.id,
            updatedByUserId: session.user.id,
          })
          .returning();
        if (!conv) throw new Error("Conversation insert failed");
        convId = conv.id;
      }

      const [userMsg] = await tx
        .insert(tables.messages)
        .values({
          tenantId: ctx.tenantId,
          workspaceId: ctx.workspaceId,
          conversationId: convId,
          parentMessageId: capabilityInput.data.parentMessageId,
          role: "user",
          content: capabilityInput.data.content,
          contentBlocks: capabilityInput.data.contentBlocks,
          branchReason: capabilityInput.data.branchReason,
          isActiveInBranch: true,
          metadata: {},
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        })
        .returning();
      if (!userMsg) throw new Error("Message insert failed");

      await tx
        .update(tables.conversations)
        .set({ activeLeafMessageId: userMsg.id, updatedAt: new Date() })
        .where(eq(tables.conversations.id, convId));

      const prior = await tx
        .select({ role: tables.messages.role, content: tables.messages.content })
        .from(tables.messages)
        .where(eq(tables.messages.conversationId, convId));

      return { conversationId: convId, userMessageId: userMsg.id, priorMessages: prior };
    });

    const coreMessages: CoreMessage[] = priorMessages
      .filter((m: any) => m.role === "user" || m.role === "assistant" || m.role === "system")
      .map((m: any) => ({ role: m.role, content: m.content }));

    // Stream the reply; buffer into `fullText` while writing the final
    // row on stream end. We do not push tokens to ClickHouse from here —
    // apps/api owns that write per §3.
    let fullText = "";
    // Materialize agent-surface capabilities as AI SDK tools for this
    // turn. Workspace scope flows through the CapabilityContext so each
    // handler enforces its own tenant guard.
    const agentTools = await materializeTools({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      userId: session.user.id,
      apiKeyId: null,
      requestId: userMessageId ?? randomUUID(),
      surface: "app",
      messageId: userMessageId,
    });
    const result = streamAgentReply({
      messages: coreMessages,
      model: defaultModel(),
      tools: agentTools,
      onFinish: async (event) => {
        fullText = event.text;
        const [assistantMsg] = await db()
          .insert(tables.messages)
          .values({
            tenantId: ctx.tenantId,
            workspaceId: ctx.workspaceId,
            conversationId,
            parentMessageId: userMessageId,
            role: "assistant",
            content: fullText,
            contentBlocks: [{ type: "text", text: fullText }],
            branchReason: null,
            isActiveInBranch: true,
            metadata: { finishReason: event.finishReason, usage: event.usage },
            createdByUserId: session.user.id,
            updatedByUserId: session.user.id,
          })
          .returning();
        if (assistantMsg) {
          await db()
            .update(tables.conversations)
            .set({ activeLeafMessageId: assistantMsg.id, updatedAt: new Date() })
            .where(eq(tables.conversations.id, conversationId));
        }
      },
    });

    // Drain the stream so the model call actually completes inside the
    // action. The RSC revalidate below picks up the persisted reply.
    for await (const _chunk of result.textStream) {
      // intentionally ignored — onFinish handles persistence
    }

    revalidatePath(`/${ctx.tenantSlug}/${ctx.workspaceSlug}/chat`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send message";
    return { ok: false, error: message };
  }
}

// Capability-dispatch helpers for the chat UI. Each one validates input
// via the capability's Zod schema, then calls its handler. The shared
// context shape is unified per the spec — workspace + tenant + user.
function capabilityContext(ctx: {
  tenantId: string;
  workspaceId: string;
  userId: string;
}) {
  // The chat UI runs server actions inside the user session, so apiKeyId
  // is always null and we mint a per-call requestId for trace correlation.
  return {
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
  } as Parameters<typeof agentApprovalResolveHandler>[1];
}

export async function resolveApprovalAction(
  ctx: { tenantSlug: string; workspaceSlug: string; tenantId: string; workspaceId: string },
  approvalId: string,
  decision: "approved" | "denied",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  const parsed = agentApprovalResolve.input.safeParse({ approvalId, decision });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await agentApprovalResolveHandler(
      parsed.data,
      capabilityContext({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, userId: session.user.id }),
    );
    revalidatePath(`/${ctx.tenantSlug}/${ctx.workspaceSlug}/chat`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to resolve approval" };
  }
}

export async function resolvePlanAction(
  ctx: { tenantSlug: string; workspaceSlug: string; tenantId: string; workspaceId: string },
  planId: string,
  decision: "approved" | "denied" | "amended",
  amendedSteps?: PlanStep[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
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
    await agentPlanApproveHandler(
      parsed.data,
      capabilityContext({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, userId: session.user.id }),
    );
    revalidatePath(`/${ctx.tenantSlug}/${ctx.workspaceSlug}/chat`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to resolve plan" };
  }
}

export async function cancelBackgroundTaskAction(
  ctx: { tenantSlug: string; workspaceSlug: string; tenantId: string; workspaceId: string },
  taskId: string,
  reason?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  const parsed = agentTaskBackgroundCancel.input.safeParse({ taskId, reason });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await agentTaskBackgroundCancelHandler(
      parsed.data,
      capabilityContext({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, userId: session.user.id }),
    );
    revalidatePath(`/${ctx.tenantSlug}/${ctx.workspaceSlug}/chat`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel task" };
  }
}

export async function readBackgroundTaskAction(
  ctx: { tenantId: string; workspaceId: string },
  taskId: string,
): Promise<BackgroundTaskSnapshot> {
  const session = await getSessionOrRedirect();
  const parsed = agentTaskBackgroundRead.input.parse({ taskId });
  const out = await agentTaskBackgroundReadHandler(
    parsed,
    capabilityContext({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, userId: session.user.id }),
  );
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
}
