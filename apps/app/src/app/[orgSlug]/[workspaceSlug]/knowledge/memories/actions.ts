"use server";

/**
 * actions.ts — server actions for Knowledge → Memories: edit and delete.
 *
 * These follow the exact same pattern as settings/memory/actions.ts:
 *   1. getSessionOrRedirect() → session guard
 *   2. resolveOrg / resolveWorkspace → IDOR + org/workspace resolution
 *   3. assertOrgMember() → org membership guard
 *   4. assertWorkspaceMember() (inline) → workspace role guard, since
 *      apps/app does NOT bootstrap IAM and invoke() skips role checks
 *   5. invoke() with surface: "agent" (agent.memory.* is surfaces: ["api","mcp","agent"],
 *      NOT "app", so passing "app" would throw surface_denied)
 *   6. revalidatePath() → invalidate the memories list RSC
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect imports: bind every handler so invoke() can resolve
// (same pattern as settings/memory/actions.ts).
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { withTenantDb, schema } from "@oxagen/database";
import type { AgentMemoryRecord } from "@oxagen/oxagen/contracts/agent.memory.list";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Result types (exported for client prop typing)
// ---------------------------------------------------------------------------

export type CreateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

export type UpdateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

export type DeleteMemoryResult =
  | { ok: true }
  | { ok: false; error: string };

/** The five AgentMemory kinds — the "type" a manual memory can be filed as. */
type MemoryKind =
  | "routine-change"
  | "constraint"
  | "bug-root-cause"
  | "convention-deviation"
  | "gotcha";

type MemoryWeight = "low" | "high" | "critical";

// ---------------------------------------------------------------------------
// Shared IAM helper
//
// apps/app never bootstraps IAM — invoke() skips role checks in the app
// surface. We re-read the caller's workspace role from Postgres before any
// mutation (same gate the memory-policy write uses for owner-only ops, but
// lowered to "member" since the contract allows Owners and Members to
// update/delete their workspace's memories).
// ---------------------------------------------------------------------------

async function assertWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<"ok" | "denied"> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({ role: schema.workspaceUsers.role })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, workspaceId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  const role = rows[0]?.role ?? "";
  return ["owner", "member"].includes(role.toLowerCase()) ? "ok" : "denied";
}

// ---------------------------------------------------------------------------
// createMemoryAction
//
// Captures a manual, one-off memory of any kind from the Memories tab. Routes
// through agent.memory.remember — the human-facing "just remember this" entry
// point — rather than agent.memory.write: remember takes free-text, infers the
// kind + weight when the user does not pin them, defaults the anchor to the
// "user-memory" bucket, and stamps source "user". When the user *does* pick a
// kind and/or weight we pass them through so the write is deterministic and the
// classifier (a metered AI call) is skipped.
//
// `source` is fixed to "user" here — this is a human-authored note — and is not
// exposed as a free-text field because remember's source is a closed enum,
// unlike update's free-string source.
// ---------------------------------------------------------------------------

export async function createMemoryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  text: string;
  kind?: MemoryKind;
  weight?: MemoryWeight;
}): Promise<CreateMemoryResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, text, kind, weight } = input;

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter what the agent should remember." };
  }

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // IDOR guard: caller must be an org member.
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    // Workspace membership gate — apps/app skips IAM, so enforce here.
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to add memories.",
      };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      // Only send kind/weight when pinned; omitting them lets the handler's
      // classifier infer the salience bucket and kind from the lesson text.
      const out = (await invoke(
        "agent.memory.remember",
        {
          text: trimmed,
          ...(kind ? { kind } : {}),
          ...(weight ? { weight } : {}),
          source: "user" as const,
        },
        ctx,
        { surface: "agent" },
      )) as { memory: AgentMemoryRecord };

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memories`);
      return { ok: true, memory: out.memory };
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to add memory." };
    }
  });
}

// ---------------------------------------------------------------------------
// updateMemoryAction
//
// Edits an AgentMemory in place. At least one mutable field (lesson, kind,
// weight, confidence, source) must differ from the stored value — the contract
// handler enforces this and the client skips the action if nothing changed.
// ---------------------------------------------------------------------------

export async function updateMemoryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  lesson?: string;
  weight?: MemoryWeight;
  kind?: MemoryKind;
  source?: string;
  confidence?: number;
}): Promise<UpdateMemoryResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, memoryId, ...updates } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // IDOR guard: caller must be an org member.
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    // Workspace membership gate — apps/app skips IAM, so enforce here.
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to edit memories." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const memory = (await invoke(
        "agent.memory.update",
        { memoryId, ...updates },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryRecord;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memories`);
      return { ok: true, memory };
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to update memory." };
    }
  });
}

// ---------------------------------------------------------------------------
// deleteMemoryAction
//
// Permanently removes an AgentMemory node and its REMEMBERS/ABOUT edges from
// Neo4j. Prefer agent.memory.update to lower salience when you only want the
// memory to stop surfacing in recall — this is truly destructive.
// ---------------------------------------------------------------------------

export async function deleteMemoryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
}): Promise<DeleteMemoryResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, memoryId } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return { ok: false, error: "You must be a workspace member to delete memories." };
    }

    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      await invoke(
        "agent.memory.delete",
        { memoryId },
        ctx,
        { surface: "agent" },
      );

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memories`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to delete memory." };
    }
  });
}
