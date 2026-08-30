"use server";
/**
 * shell-actions.ts — org-level shell actions for the global wand widget.
 *
 * The wand panel is mounted once at the [orgSlug] layout boundary so it
 * persists across all pages within an org. Because the layout has no access
 * to [workspaceSlug], the client resolves the active workspace from the URL
 * and passes it as FormData fields (`orgSlug` + `workspaceSlug`). This action
 * then resolves the workspace IDs server-side — never trusting client-supplied IDs.
 *
 * When the path has no active workspace (e.g. org-level settings) the client
 * supplies the first available workspace slug or an empty string. If neither
 * org nor workspace can be resolved we return a graceful error so the panel
 * renders without crashing.
 */

import "@oxagen/handlers/register";
// agent.* capabilities live in a separate package; its register module must run
// to bind them into the kernel before the wand*Action invoke() calls below.
import "@oxagen/agent/register";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type { DbMessageRow, ConversationRow } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import type { PlanStep } from "@/components/chat/stream-event-types";
import type { ChatMessage } from "@/components/chat/chat-shell";
import { walkActiveBranch } from "./[workspaceSlug]/_shared/walk-active-branch";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { agentMcpConsentResolve } from "@oxagen/oxagen/contracts/agent.mcp_consent.resolve";
import { agentPlanApprove } from "@oxagen/oxagen/contracts/agent.plan.approve";
import { invoke } from "@oxagen/oxagen";
import { logger } from "@oxagen/handlers/logger";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const WandSendSchema = z.object({
  // Slugs — supplied by the client from the current URL.
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  // Message fields
  content: z.string().min(1),
  conversationId: z.string().nullable().default(null),
  parentMessageId: z.string().nullable().default(null),
  branchReason: z
    .enum(["edit", "regenerate", "tool_retry", "manual_fork"])
    .nullable()
    .default(null),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Assert user is a member of the workspace. Returns true on success, false if not a member. */
async function assertWorkspaceMember(
  orgId: string,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  return runInTenantScope(
    { orgId, workspaceId },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ id: schema.workspaceUsers.id })
          .from(schema.workspaceUsers)
          .where(
            and(
              eq(schema.workspaceUsers.workspaceId, workspaceId),
              eq(schema.workspaceUsers.userId, userId),
            ),
          )
          .limit(1),
      ),
    // Membership is proven by the row count — a zero-row result means the user
    // is NOT a workspace member. The previous `.then(() => true)` discarded the
    // rows and granted access to any caller whenever the DB query succeeded.
  )
    .then((rows) => rows.length > 0)
    .catch((err) => {
      // Fail closed on RLS / tenancy errors — but log first so a systemic
      // membership-check outage is observable instead of silently denying.
      logger.warn(
        { err, workspaceId, userId },
        "shell: workspace membership check errored — treating as non-member",
      );
      return false;
    });
}

/** Resolve org + workspace from slugs, returning null on any lookup failure. */
async function resolveWorkspaceFromSlugs(
  orgSlug: string,
  workspaceSlug: string,
): Promise<{ orgId: string; workspaceId: string } | null> {
  try {
    const orgRows = await withSystemDb((tx) =>
      tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, orgSlug))
        .limit(1),
    );
    const org = orgRows[0];
    if (!org) return null;

    const wsRows = await withSystemDb((tx) =>
      tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.orgId, org.id),
            eq(schema.workspaces.slug, workspaceSlug),
          ),
        )
        .limit(1),
    );
    const ws = wsRows[0];
    if (!ws) return null;

    return { orgId: org.id, workspaceId: ws.id };
  } catch (err) {
    // Log before degrading: a DB/RLS outage and a genuinely unknown slug are
    // indistinguishable to the caller, so without this line a systemic lookup
    // failure reads to operators as "users keep mistyping workspace slugs".
    logger.warn(
      { err, orgSlug, workspaceSlug },
      "shell: workspace slug resolution errored — treating as not found",
    );
    return null;
  }
}

function buildCapabilityContext(opts: {
  orgId: string;
  workspaceId: string;
  userId: string;
}) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

// ---------------------------------------------------------------------------
// wandSendAction — the real, working send action for the global wand panel.
//
// The client resolves the active workspace slug from the current URL and
// appends `orgSlug` + `workspaceSlug` as hidden FormData fields before
// submitting. This action resolves them to IDs server-side.
// ---------------------------------------------------------------------------

export async function wandSendAction(formData: FormData): Promise<
  | {
      ok: true;
      conversationId: string;
      conversationPublicId: string;
      userMessageId: string;
    }
  | { ok: false; error: string }
> {
  const session = await getSessionOrRedirect();
  const raw = Object.fromEntries(formData);

  const parsed = WandSendSchema.safeParse({
    orgSlug: raw.orgSlug ? String(raw.orgSlug) : "",
    workspaceSlug: raw.workspaceSlug ? String(raw.workspaceSlug) : "",
    content: raw.content,
    conversationId: raw.conversationId ? String(raw.conversationId) : null,
    parentMessageId: raw.parentMessageId ? String(raw.parentMessageId) : null,
    branchReason: raw.branchReason ? String(raw.branchReason) : null,
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid message",
    };
  }

  const {
    orgSlug,
    workspaceSlug,
    content,
    conversationId,
    parentMessageId,
    branchReason,
  } = parsed.data;

  // Resolve IDs from slugs server-side — never trust client-supplied IDs.
  const resolved = await resolveWorkspaceFromSlugs(orgSlug, workspaceSlug);
  if (!resolved) {
    return {
      ok: false,
      error:
        "Workspace not found. Please navigate to a workspace and try again.",
    };
  }
  const { orgId, workspaceId } = resolved;

  // Assert user is a member of the workspace (explicit IAM gate in apps/app).
  const isMember = await assertWorkspaceMember(
    orgId,
    workspaceId,
    session.user.id,
  );
  if (!isMember) {
    return { ok: false, error: "You don't have access to this workspace." };
  }

  // Verify the capability input before entering the tenant scope.
  const capabilityInput = chatMessageSend.input.safeParse({
    conversationId,
    parentMessageId,
    branchReason,
    content,
    contentBlocks: [],
  });
  if (!capabilityInput.success) {
    return {
      ok: false,
      error: capabilityInput.error.issues[0]?.message ?? "Invalid",
    };
  }

  return await runInTenantScope({ orgId, workspaceId }, async () => {
    try {
      const {
        conversationId: convId,
        conversationPublicId,
        userMessageId,
      } = await withTenantDb(async (tx) => {
        let cId: string;
        let cPublicId: string;
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
                eq(schema.conversations.orgId, orgId),
                eq(schema.conversations.workspaceId, workspaceId),
              ),
            )
            .limit(1);
          if (!existing) throw new Error("Conversation not found");
          cId = existing.id;
          cPublicId = existing.publicId;
          currentLeaf = existing.leaf ?? null;
        } else {
          const [conv] = await tx
            .insert(schema.conversations)
            .values({
              orgId,
              workspaceId,
              userId: session.user.id,
              status: "active",
              createdByUserId: session.user.id,
              updatedByUserId: session.user.id,
            })
            .returning();
          if (!conv) throw new Error("Conversation insert failed");
          const typedConv = conv as ConversationRow;
          cId = typedConv.id;
          cPublicId = typedConv.publicId;
          currentLeaf = null;
        }

        // Thread the user message onto the server-authoritative active leaf —
        // mirrors the sendMessageAction threading in [workspaceSlug]/ask/actions.ts.
        const parentMsgId =
          branchReason && capabilityInput.data.parentMessageId
            ? capabilityInput.data.parentMessageId
            : currentLeaf;

        const [userMsg] = await tx
          .insert(schema.messages)
          .values({
            orgId,
            workspaceId,
            conversationId: cId,
            parentMessageId: parentMsgId ?? undefined,
            role: "user",
            content,
            contentBlocks: [],
            branchReason: branchReason ?? undefined,
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
          .where(eq(schema.conversations.id, cId));

        return {
          conversationId: cId,
          conversationPublicId: cPublicId,
          userMessageId: typedMsg.id,
        };
      });

      revalidatePath(`/${orgSlug}/${workspaceSlug}/sessions`);
      return {
        ok: true,
        conversationId: convId,
        conversationPublicId,
        userMessageId,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send message";
      return { ok: false, error: message };
    }
  });
}

// ---------------------------------------------------------------------------
// loadAgentConversationAction — reload the active-branch messages for a
// conversation the floating agent panel is driving.
//
// The in-app agent drawer is mounted at the org layout and has no RSC of its
// own, so it cannot rely on the router.refresh()/`?c=` reconciliation the full
// /ask page uses. Instead it owns its conversation state in React and calls
// this action after each turn to pull the just-persisted user + assistant
// messages back into the panel — so the user's prompt and the assistant reply
// stay on screen and survive the next send (instead of vanishing).
//
// Workspace-scoped read: org + workspace are resolved from slugs server-side
// and membership is asserted before any row is read.
// ---------------------------------------------------------------------------

export async function loadAgentConversationAction(
  orgSlug: string,
  workspaceSlug: string,
  conversationPublicId: string,
): Promise<
  | {
      ok: true;
      conversationId: string;
      messages: ChatMessage[];
      activeLeafMessageId: string | null;
      title: string | null;
    }
  | { ok: false; error: string }
> {
  const session = await getSessionOrRedirect();

  const resolved = await resolveWorkspaceFromSlugs(orgSlug, workspaceSlug);
  if (!resolved) return { ok: false, error: "No active workspace." };
  const { orgId, workspaceId } = resolved;

  const isMember = await assertWorkspaceMember(
    orgId,
    workspaceId,
    session.user.id,
  );
  if (!isMember)
    return { ok: false, error: "You don't have access to this workspace." };

  return runInTenantScope({ orgId, workspaceId }, async () => {
    try {
      const [conv] = await withTenantDb((tx) =>
        tx
          .select({
            id: schema.conversations.id,
            title: schema.conversations.title,
            leaf: schema.conversations.activeLeafMessageId,
          })
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.publicId, conversationPublicId),
              eq(schema.conversations.orgId, orgId),
              eq(schema.conversations.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      );
      if (!conv) return { ok: false as const, error: "Conversation not found" };

      const leaf = conv.leaf ?? null;
      const rows = (await withTenantDb((tx) =>
        tx
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.conversationId, conv.id))
          .orderBy(desc(schema.messages.createdAt))
          .limit(200),
      )) as DbMessageRow[];

      return {
        ok: true as const,
        conversationId: conv.id,
        messages: walkActiveBranch(rows, leaf),
        activeLeafMessageId: leaf,
        title: conv.title ?? null,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load conversation";
      return { ok: false as const, error: message };
    }
  });
}

// ---------------------------------------------------------------------------
// wandResolveApprovalAction
//
// Called from the wand panel's scoped approval resolver. The orgSlug and
// workspaceSlug are passed explicitly (not via FormData) because this action
// is not a ComposerAction — it's a regular async server action called directly
// from the wand panel's useCallback wrappers.
// ---------------------------------------------------------------------------

export async function wandResolveApprovalAction(
  orgSlug: string,
  workspaceSlug: string,
  approvalId: string,
  decision: "approved" | "denied",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();

  const resolved = await resolveWorkspaceFromSlugs(orgSlug, workspaceSlug);
  if (!resolved) return { ok: false, error: "No active workspace." };
  const { orgId, workspaceId } = resolved;

  // Assert user is a member of the workspace (explicit IAM gate in apps/app —
  // invoke() from apps/app skips IAM role checks, so without this any
  // authenticated user who knows/guesses an orgSlug + workspaceSlug +
  // approvalId could resolve approvals in a workspace they don't belong to).
  const isMember = await assertWorkspaceMember(
    orgId,
    workspaceId,
    session.user.id,
  );
  if (!isMember)
    return { ok: false, error: "You don't have access to this workspace." };

  const parsed = agentApprovalResolve.input.safeParse({ approvalId, decision });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };

  try {
    await invoke(
      "resolve_approval",
      parsed.data,
      buildCapabilityContext({ orgId, workspaceId, userId: session.user.id }),
      { surface: "agent" },
    );
    revalidatePath(`/${orgSlug}/${workspaceSlug}/sessions`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to resolve approval",
    };
  }
}

// ---------------------------------------------------------------------------
// wandResolveConsentAction
//
// Mirrors wandResolveApprovalAction for first-use external-MCP consent. The
// orgSlug/workspaceSlug are passed explicitly and resolved to IDs server-side;
// the consent decision resumes the paused agent stream.
// ---------------------------------------------------------------------------

export async function wandResolveConsentAction(
  orgSlug: string,
  workspaceSlug: string,
  approvalId: string,
  decision: "granted" | "denied",
  grantAllTools: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();

  const resolved = await resolveWorkspaceFromSlugs(orgSlug, workspaceSlug);
  if (!resolved) return { ok: false, error: "No active workspace." };
  const { orgId, workspaceId } = resolved;

  // Assert user is a member of the workspace (explicit IAM gate in apps/app —
  // see wandResolveApprovalAction above for why this cannot rely on invoke()'s
  // kernel IAM check from this surface).
  const isMember = await assertWorkspaceMember(
    orgId,
    workspaceId,
    session.user.id,
  );
  if (!isMember)
    return { ok: false, error: "You don't have access to this workspace." };

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
      buildCapabilityContext({ orgId, workspaceId, userId: session.user.id }),
      { surface: "agent" },
    );
    revalidatePath(`/${orgSlug}/${workspaceSlug}/sessions`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to resolve consent",
    };
  }
}

// ---------------------------------------------------------------------------
// wandResolvePlanAction
// ---------------------------------------------------------------------------

export async function wandResolvePlanAction(
  orgSlug: string,
  workspaceSlug: string,
  planId: string,
  decision: "approved" | "denied" | "amended",
  amendedSteps?: PlanStep[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();

  const resolved = await resolveWorkspaceFromSlugs(orgSlug, workspaceSlug);
  if (!resolved) return { ok: false, error: "No active workspace." };
  const { orgId, workspaceId } = resolved;

  // Assert user is a member of the workspace (explicit IAM gate in apps/app —
  // see wandResolveApprovalAction above for why this cannot rely on invoke()'s
  // kernel IAM check from this surface).
  const isMember = await assertWorkspaceMember(
    orgId,
    workspaceId,
    session.user.id,
  );
  if (!isMember)
    return { ok: false, error: "You don't have access to this workspace." };

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
      buildCapabilityContext({ orgId, workspaceId, userId: session.user.id }),
      { surface: "agent" },
    );
    revalidatePath(`/${orgSlug}/${workspaceSlug}/sessions`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to resolve plan",
    };
  }
}
