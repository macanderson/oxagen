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
import { agentMcpConsentResolve } from "@oxagen/oxagen/contracts/agent.mcp_consent.resolve";
import { agentPlanApprove } from "@oxagen/oxagen/contracts/agent.plan.approve";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/contracts/agent.background_task.cancel";
import { agentTaskBackgroundRead } from "@oxagen/oxagen/contracts/agent.background_task.read";
import { invoke } from "@oxagen/oxagen";
import type { PlanStep } from "@/components/chat/stream-event-types";
import type { BackgroundTaskSnapshot } from "@/components/chat/background-task-tray";
import { getSessionOrRedirect } from "@/lib/session";
import { assertWorkspaceMember } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import { parseAttachmentsField } from "./parse-attachments";

// A composer-serialized attachment ref — mirrors MessageAttachment
// (apps/app/src/components/chat/message-bubble.tsx). Bounded to 8 to match
// the chat stream route's `attachments` cap; refs only, never bytes.
const attachmentSchema = z.object({
  publicId: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  url: z.string().min(1),
});

const FormSchema = z.object({
  content: z.string().min(1),
  conversationId: z.string().nullable().default(null),
  parentMessageId: z.string().nullable().default(null),
  branchReason: z
    .enum(["edit", "regenerate", "tool_retry", "manual_fork"])
    .nullable()
    .default(null),
  attachments: z.array(attachmentSchema).max(8).default([]),
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
  ctx: {
    orgSlug: string;
    workspaceSlug: string;
    orgId: string;
    workspaceId: string;
  },
  formData: FormData,
): Promise<
  | {
      ok: true;
      conversationId: string;
      conversationPublicId: string;
      userMessageId: string;
    }
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
    attachments: parseAttachmentsField(
      formData.get("attachments") ?? undefined,
    ),
  });
  if (!parsed.success) return { ok: false, error: "Invalid message" };

  const capabilityInput = chatMessageSend.input.safeParse({
    conversationId: parsed.data.conversationId,
    parentMessageId: parsed.data.parentMessageId,
    branchReason: parsed.data.branchReason,
    content: parsed.data.content,
    contentBlocks: [],
  });
  if (!capabilityInput.success)
    return {
      ok: false,
      error: capabilityInput.error.issues[0]?.message ?? "Invalid",
    };

  return await runInTenantScope(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    async () => {
      try {
        const { conversationId, conversationPublicId, userMessageId } =
          await withTenantDb(async (tx) => {
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
                    eq(
                      schema.conversations.id,
                      capabilityInput.data.conversationId,
                    ),
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
                // Attachment refs (publicId + display fields) so message-bubble
                // can render thumbnails on refresh without a second round-trip —
                // the stream route separately re-resolves each publicId
                // server-side (ownership + status='ready') before building image
                // parts for the model; this metadata is display-only.
                metadata:
                  parsed.data.attachments.length > 0
                    ? { attachments: parsed.data.attachments }
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

            return {
              conversationId: convId,
              conversationPublicId: convPublicId,
              userMessageId: typedMsg.id,
            };
          });

        revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/sessions`);
        return {
          ok: true,
          conversationId,
          conversationPublicId,
          userMessageId,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to send message";
        logger.error(
          { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
          "[ask] sendMessageAction failed",
        );
        return { ok: false, error: message };
      }
    },
  );
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
  ctx: {
    orgSlug: string;
    workspaceSlug: string;
    orgId: string;
    workspaceId: string;
  },
  approvalId: string,
  decision: "approved" | "denied",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  const parsed = agentApprovalResolve.input.safeParse({ approvalId, decision });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "resolve_approval",
      parsed.data,
      capabilityContext({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: session.user.id,
      }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/sessions`);
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, approvalId },
      "[ask] resolveApprovalAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to resolve approval",
    };
  }
}

export async function resolveConsentAction(
  ctx: {
    orgSlug: string;
    workspaceSlug: string;
    orgId: string;
    workspaceId: string;
  },
  approvalId: string,
  decision: "granted" | "denied",
  grantAllTools: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  const parsed = agentMcpConsentResolve.input.safeParse({
    approvalId,
    decision,
    grantAllTools,
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "resolve_mcp_consent",
      parsed.data,
      capabilityContext({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: session.user.id,
      }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/sessions`);
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, approvalId },
      "[ask] resolveConsentAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to resolve consent",
    };
  }
}

export async function resolvePlanAction(
  ctx: {
    orgSlug: string;
    workspaceSlug: string;
    orgId: string;
    workspaceId: string;
  },
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
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "approve_plan",
      parsed.data,
      capabilityContext({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: session.user.id,
      }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/sessions`);
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, planId },
      "[ask] resolvePlanAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to resolve plan",
    };
  }
}

export async function cancelBackgroundTaskAction(
  ctx: {
    orgSlug: string;
    workspaceSlug: string;
    orgId: string;
    workspaceId: string;
  },
  taskId: string,
  reason?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  await assertWorkspaceMember(ctx.workspaceId, session.user.id);
  const parsed = agentTaskBackgroundCancel.input.safeParse({ taskId, reason });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    await invoke(
      "cancel_background_task",
      parsed.data,
      capabilityContext({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: session.user.id,
      }),
      { surface: "agent" },
    );
    revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/sessions`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to cancel task",
    };
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
    const out = (await invoke(
      "get_background_task",
      parsed.data,
      capabilityContext({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: session.user.id,
      }),
      { surface: "agent" },
    )) as import("@oxagen/oxagen/contracts/agent.background_task.read").AgentTaskBackgroundReadOutput;
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
    const failureReason =
      err instanceof Error ? err.message : "Failed to read task status";
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
