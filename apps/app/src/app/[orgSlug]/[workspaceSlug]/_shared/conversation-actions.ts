"use server";
/**
 * conversation-actions.ts — server actions backing the workspace conversation
 * history nav (apps/app/src/components/conversations/*). One action per
 * conversation capability; each resolves org + workspace from slugs, asserts
 * membership (IDOR guard), then dispatches through the single kernel
 * `invoke()` chokepoint so metering, IAM, and audit run on every call. Shared
 * by the /ask and /chat surfaces — both render the same nav, so the actions
 * live in _shared rather than per-route.
 */
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every handler into the kernel so invoke() can
// resolve the conversation.* handlers at runtime. Without it invoke() throws
// "No handler registered" (the type system can't catch a missing side-effect
// import). Mirrors models-action.ts and the chat stream route.
import "@oxagen/handlers/register";
import { conversationList } from "@oxagen/oxagen/contracts/conversation.list";
import { conversationRename } from "@oxagen/oxagen/contracts/conversation.rename";
import { conversationArchive } from "@oxagen/oxagen/contracts/conversation.archive";
import { conversationDelete } from "@oxagen/oxagen/contracts/conversation.delete";
import { conversationPurge } from "@oxagen/oxagen/contracts/conversation.purge";
import type { ConversationListOutput } from "@oxagen/oxagen/contracts/conversation.list";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

/** Slug context the client carries from the URL; org/workspace ids resolve server-side. */
export interface ConversationActionCtx {
  orgSlug: string;
  workspaceSlug: string;
}

export type ListConversationsResult =
  | {
      ok: true;
      conversations: ConversationListOutput["conversations"];
      nextCursor: string | null;
    }
  | { ok: false; error: string };

export type MutationResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

// Resolve scope + caller once per action. Asserting org membership before any
// capability call is the IDOR guard (mirrors models-action.ts): the slug alone
// must never grant access to another tenant's conversations.
async function resolveScope(ctx: ConversationActionCtx) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(ctx.orgSlug);
  const ws = await resolveWorkspace(org.id, ctx.workspaceSlug);
  await assertOrgMember(org.id, session.user.id);
  return {
    userId: session.user.id,
    capabilityCtx: {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    },
  };
}

function revalidateConversationSurfaces(ctx: ConversationActionCtx) {
  // /ask is the canonical full-page conversation surface; revalidate it so the
  // nav list is fresh after a mutation. (Legacy /chat is now a redirect to /ask.)
  revalidatePath(`/${ctx.orgSlug}/${ctx.workspaceSlug}/sessions`);
}

export async function listConversationsAction(
  ctx: ConversationActionCtx,
  args: { filter: "active" | "archived"; cursor?: string | null },
): Promise<ListConversationsResult> {
  const parsed = conversationList.input.safeParse({
    filter: args.filter,
    cursor: args.cursor ?? null,
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    const { capabilityCtx } = await resolveScope(ctx);
    const out = (await invoke(
      conversationList.name,
      parsed.data,
      capabilityCtx,
      {
        surface: "agent",
      },
    )) as ConversationListOutput;
    return {
      ok: true,
      conversations: out.conversations,
      nextCursor: out.nextCursor,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to load conversations",
    };
  }
}

export async function renameConversationAction(
  ctx: ConversationActionCtx,
  conversationId: string,
  title: string,
): Promise<MutationResult> {
  const parsed = conversationRename.input.safeParse({ conversationId, title });
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid title",
    };
  try {
    const { capabilityCtx } = await resolveScope(ctx);
    await invoke(conversationRename.name, parsed.data, capabilityCtx, {
      surface: "agent",
    });
    revalidateConversationSurfaces(ctx);
    return { ok: true, count: 1 };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to rename conversation",
    };
  }
}

export async function archiveConversationsAction(
  ctx: ConversationActionCtx,
  conversationIds: string[],
  archived: boolean,
): Promise<MutationResult> {
  const parsed = conversationArchive.input.safeParse({
    conversationIds,
    archived,
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    const { capabilityCtx } = await resolveScope(ctx);
    const out = (await invoke(
      conversationArchive.name,
      parsed.data,
      capabilityCtx,
      {
        surface: "agent",
      },
    )) as { updated: number };
    revalidateConversationSurfaces(ctx);
    return { ok: true, count: out.updated };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to archive",
    };
  }
}

export async function deleteConversationsAction(
  ctx: ConversationActionCtx,
  conversationIds: string[],
): Promise<MutationResult> {
  const parsed = conversationDelete.input.safeParse({ conversationIds });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
  try {
    const { capabilityCtx } = await resolveScope(ctx);
    const out = (await invoke(
      conversationDelete.name,
      parsed.data,
      capabilityCtx,
      {
        surface: "agent",
      },
    )) as { deleted: number };
    revalidateConversationSurfaces(ctx);
    return { ok: true, count: out.deleted };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete",
    };
  }
}

export async function purgeArchivedConversationsAction(
  ctx: ConversationActionCtx,
): Promise<MutationResult> {
  try {
    const { capabilityCtx } = await resolveScope(ctx);
    const out = (await invoke(conversationPurge.name, {}, capabilityCtx, {
      surface: "agent",
    })) as { deleted: number };
    revalidateConversationSurfaces(ctx);
    return { ok: true, count: out.deleted };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to purge archived",
    };
  }
}
