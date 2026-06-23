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
import { graphIngest } from "@oxagen/oxagen/contracts/graph.ingest";
import { graphNodeUpsert } from "@oxagen/oxagen/contracts/graph.node.upsert";
import { invoke } from "@oxagen/oxagen";
import type { PlanStep } from "@/components/chat/stream-event-types";
import type { BackgroundTaskSnapshot } from "@/components/chat/background-task-tray";
import { getSessionOrRedirect } from "@/lib/session";
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
    parentMessageId: parsed.data.parentMessageId,
    branchReason: parsed.data.branchReason,
    content: parsed.data.content,
    contentBlocks: [],
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
            metadata: {},
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

// ── Save assistant message to knowledge graph / memory ────────────────────
// Both actions are user-initiated from the chat message footer's icon buttons.
// They run the message text through the SAME entity-extraction + embedding
// pipeline the rest of the platform uses (graph.ingest), so the saved nodes
// are discoverable globally via the workspace entity search contract
// (graph.node.search). Save-as-Memory creates a dedicated "Memory" labeled
// node first, then runs ingestion against the same text so derived entities
// link to the workspace ontology.

export interface SaveAssistantTextResult {
  ok: boolean;
  /** Saved Memory node id (Save-as-Memory only). */
  memoryNodeId?: string;
  /** Count of new entities the ingestion pipeline extracted. */
  entitiesCreated?: number;
  error?: string;
}

const MAX_SAVE_LEN = 50_000;

function trimToLimit(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_SAVE_LEN ? trimmed.slice(0, MAX_SAVE_LEN) : trimmed;
}

export async function saveMessageAsKnowledgeAction(
  ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
  text: string,
  sourceUrl?: string,
): Promise<SaveAssistantTextResult> {
  const session = await getSessionOrRedirect();
  const trimmed = trimToLimit(text);
  if (trimmed.length === 0) return { ok: false, error: "Message is empty" };

  return runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
    try {
      const parsed = graphIngest.input.safeParse({
        text: trimmed,
        ...(sourceUrl ? { sourceUrl } : {}),
      });
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
      }
      const out = (await invoke(
        "graph.ingest",
        parsed.data,
        capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
        { surface: "api" },
      )) as import("@oxagen/oxagen/contracts/graph.ingest").GraphIngestOutput;
      return {
        ok: true,
        entitiesCreated: out.entities.filter((e) => e.created).length,
      };
    } catch (err) {
      logger.error(
        { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        "[chat] saveMessageAsKnowledgeAction failed",
      );
      return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
    }
  });
}

export async function saveMessageAsMemoryAction(
  ctx: { orgSlug: string; workspaceSlug: string; orgId: string; workspaceId: string },
  text: string,
  conversationPublicId?: string,
): Promise<SaveAssistantTextResult> {
  const session = await getSessionOrRedirect();
  const trimmed = trimToLimit(text);
  if (trimmed.length === 0) return { ok: false, error: "Message is empty" };

  return runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
    try {
      // First-line summary makes a stable displayName, the full text becomes the
      // node's description so the workspace entity-search contract finds it.
      const firstLine = trimmed.split("\n", 1)[0]?.trim() ?? trimmed;
      const displayName = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
      const description = trimmed.length > 2000 ? trimmed.slice(0, 2000) : trimmed;
      const upsertInput = graphNodeUpsert.input.safeParse({
        label: "Memory",
        displayName: displayName.length === 0 ? "Memory" : displayName,
        description,
        properties: {
          source: "chat-message",
          ...(conversationPublicId ? { conversationPublicId } : {}),
          savedBy: session.user.id,
          savedAt: new Date().toISOString(),
        },
      });
      if (!upsertInput.success) {
        return { ok: false, error: upsertInput.error.issues[0]?.message ?? "Invalid input" };
      }
      const upsertOut = (await invoke(
        "graph.node.upsert",
        upsertInput.data,
        capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
        { surface: "api" },
      )) as import("@oxagen/oxagen/contracts/graph.node.upsert").GraphNodeUpsertOutput;

      // Run the ingestion pipeline too so embeddings + derived entity edges land
      // in the graph — same as Save-as-Knowledge does, just with a Memory anchor.
      // Best-effort: a graph.ingest failure must NOT roll back the Memory node.
      let entitiesCreated = 0;
      try {
        const ingestInput = graphIngest.input.safeParse({ text: trimmed });
        if (ingestInput.success) {
          const ingestOut = (await invoke(
            "graph.ingest",
            ingestInput.data,
            capabilityContext({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: session.user.id }),
            { surface: "api" },
          )) as import("@oxagen/oxagen/contracts/graph.ingest").GraphIngestOutput;
          entitiesCreated = ingestOut.entities.filter((e) => e.created).length;
        }
      } catch (ingestErr) {
        logger.warn(
          { err: ingestErr, memoryNodeId: upsertOut.nodeId },
          "[chat] saveMessageAsMemoryAction — ingestion follow-up failed",
        );
      }
      return { ok: true, memoryNodeId: upsertOut.nodeId, entitiesCreated };
    } catch (err) {
      logger.error(
        { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        "[chat] saveMessageAsMemoryAction failed",
      );
      return { ok: false, error: err instanceof Error ? err.message : "Save failed" };
    }
  });
}

export async function readBackgroundTaskAction(
  ctx: { orgId: string; workspaceId: string },
  taskId: string,
): Promise<BackgroundTaskSnapshot> {
  const session = await getSessionOrRedirect();
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
