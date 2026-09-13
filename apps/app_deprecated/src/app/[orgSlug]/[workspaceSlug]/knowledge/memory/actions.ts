"use server";

/**
 * actions.ts — server actions for Knowledge → Memories: create, edit, delete,
 * and promote (two-axis memory model — see docs/specs/two-axis-memory/DESIGN.md).
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
import type { AgentMemoryPromotionCandidatesOutput } from "@oxagen/oxagen/contracts/agent.memory_promotion.list";
import type { AgentMemoryCitationsListOutput } from "@oxagen/oxagen/contracts/agent.memory_citation.list";
import type { AgentMemoryEvidenceAttachOutput } from "@oxagen/oxagen/contracts/agent.memory_evidence.attach";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Result types (exported for client prop typing)
// ---------------------------------------------------------------------------

export type CreateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

export type UpdateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

export type DeleteMemoryResult = { ok: true } | { ok: false; error: string };

export type PromoteMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

export type DismissPromotionResult =
  | { ok: true; memoryId: string; dismissed: boolean }
  | { ok: false; error: string };

export type DemoteMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

export type SuggestRationalesResult =
  | { ok: true; rationales: string[] }
  | { ok: false; error: string };

export type PromotionCandidatesResult =
  | { ok: true; candidates: AgentMemoryPromotionCandidatesOutput["candidates"] }
  | { ok: false; error: string };

export type ListMemoryCitationsResult =
  | { ok: true; citations: AgentMemoryCitationsListOutput["citations"] }
  | { ok: false; error: string };

export type AttachMemoryEvidenceResult =
  | { ok: true; evidenceId: string; confidenceScore: number }
  | { ok: false; error: string };

type MemoryStatus = "ACTIVE" | "SUPERSEDED" | "RETRACTED" | "ARCHIVED";

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
// Captures a manual, one-off memory from the Memories tab. Routes through
// agent.memory.remember — the human-facing "just remember this" entry point —
// rather than agent.memory.write: remember takes free-text, infers
// memoryClass/memoryKind when the user does not pin them, defaults the anchor
// to the "user-memory" bucket, and stamps source "user". FACT is
// intentionally not offered here (see memories-client.tsx) — it requires
// human confirmation and is reserved for the promote flow.
//
// `source` is fixed to "user" here — this is a human-authored note — and is
// not exposed as a free-text field because remember's source is a closed
// enum, unlike update's free-string source.
// ---------------------------------------------------------------------------

export async function createMemoryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  text: string;
  memoryKind?: string;
  memoryClass?: "OBSERVATION" | "RULE";
  enforcementScore?: number;
}): Promise<CreateMemoryResult> {
  const session = await getSessionOrRedirect();
  const {
    orgSlug,
    workspaceSlug,
    text,
    memoryKind,
    memoryClass,
    enforcementScore,
  } = input;

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
      // Only send pinned fields; omitting them lets the handler's classifier
      // infer the class/kind from the lesson text.
      const out = (await invoke(
        "save_memory",
        {
          text: trimmed,
          ...(memoryKind ? { memoryKind } : {}),
          ...(memoryClass ? { memoryClass } : {}),
          ...(memoryClass === "RULE" && enforcementScore != null
            ? { enforcementScore }
            : {}),
          source: "user" as const,
        },
        ctx,
        { surface: "agent" },
      )) as { memory: AgentMemoryRecord };

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return { ok: true, memory: out.memory };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id },
        "knowledge.memory: createMemoryAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to add memory." };
    }
  });
}

// ---------------------------------------------------------------------------
// updateMemoryAction
//
// Edits an AgentMemory in place. At least one mutable field (lesson, kind,
// source, confidenceScore, enforcementScore, status) must differ from the
// stored value — the contract handler enforces this and the client skips the
// action if nothing changed. Class changes are NOT accepted here — they go
// through promoteMemoryAction, which records an auditable :Promotion event.
// ---------------------------------------------------------------------------

export async function updateMemoryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  lesson?: string;
  memoryKind?: string;
  source?: string;
  confidenceScore?: number;
  enforcementScore?: number;
  status?: MemoryStatus;
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
      return {
        ok: false,
        error: "You must be a workspace member to edit memories.",
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
      const memory = (await invoke(
        "update_memory",
        { memoryId, ...updates },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryRecord;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return { ok: true, memory };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, memoryId },
        "knowledge.memory: updateMemoryAction failed",
      );
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
      return {
        ok: false,
        error: "You must be a workspace member to delete memories.",
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
      await invoke("delete_memory", { memoryId }, ctx, { surface: "agent" });

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return { ok: true };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, memoryId },
        "knowledge.memory: deleteMemoryAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to delete memory." };
    }
  });
}

// ---------------------------------------------------------------------------
// promoteMemoryAction
//
// Moves a memory up the confidence ladder (OBSERVATION → RULE/FACT, or
// RULE → FACT), recording an auditable :Promotion event. Backs the "Promote"
// affordance in the memory detail sheet and the "suggested to promote" panel.
//
// `rationale` is optional (promote_memory's schema — see
// agent.memory.promote.ts). Omitted or blank rationale is simply left off the
// invoke input rather than sent as an empty string.
// ---------------------------------------------------------------------------

export async function promoteMemoryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  toClass: "RULE" | "FACT";
  enforcementScore?: number;
  rationale?: string;
  basedOnEvidenceIds?: string[];
}): Promise<PromoteMemoryResult> {
  const session = await getSessionOrRedirect();
  const {
    orgSlug,
    workspaceSlug,
    memoryId,
    toClass,
    enforcementScore,
    rationale,
    basedOnEvidenceIds,
  } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to promote memories.",
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

    const trimmedRationale = rationale?.trim();

    try {
      const memory = (await invoke(
        "promote_memory",
        {
          memoryId,
          toClass,
          ...(enforcementScore != null ? { enforcementScore } : {}),
          ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
          ...(basedOnEvidenceIds && basedOnEvidenceIds.length > 0
            ? { basedOnEvidenceIds }
            : {}),
        },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryRecord;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return { ok: true, memory };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, memoryId, toClass },
        "knowledge.memory: promoteMemoryAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to promote memory." };
    }
  });
}

// ---------------------------------------------------------------------------
// dismissPromotionAction
//
// Durably removes (or restores) a memory from the promotion candidate queue —
// dismiss_memory_promotion stamps promotion_dismissed_at rather than touching
// the memory itself, so the underlying AgentMemory stays ACTIVE and
// recallable. Backs the "Dismiss" affordance in both the dedicated promotion
// queue and the inline "suggested to promote" panel.
// ---------------------------------------------------------------------------

export async function dismissPromotionAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  restore?: boolean;
}): Promise<DismissPromotionResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, memoryId, restore } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error:
          "You must be a workspace member to dismiss promotion candidates.",
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
      const out = (await invoke(
        "dismiss_memory_promotion",
        { memoryId, ...(restore != null ? { restore } : {}) },
        ctx,
        { surface: "agent" },
      )) as { memoryId: string; dismissed: boolean };

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return { ok: true, memoryId: out.memoryId, dismissed: out.dismissed };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, memoryId },
        "knowledge.memory: dismissPromotionAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return {
        ok: false,
        error: message || "Failed to dismiss promotion candidate.",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// demoteMemoryAction
//
// Moves a memory down the confidence ladder (FACT → RULE/OBSERVATION, or
// RULE → OBSERVATION), recording an auditable :Demotion event — the inverse
// of promoteMemoryAction. Backs the "Demote" affordance in the memory detail
// sheet for RULE and FACT memories.
// ---------------------------------------------------------------------------

export async function demoteMemoryAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  toClass: "RULE" | "OBSERVATION";
  enforcementScore?: number;
  rationale?: string;
}): Promise<DemoteMemoryResult> {
  const session = await getSessionOrRedirect();
  const {
    orgSlug,
    workspaceSlug,
    memoryId,
    toClass,
    enforcementScore,
    rationale,
  } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to demote memories.",
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

    const trimmedRationale = rationale?.trim();

    try {
      const memory = (await invoke(
        "demote_memory",
        {
          memoryId,
          toClass,
          ...(toClass === "RULE" && enforcementScore != null
            ? { enforcementScore }
            : {}),
          ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
        },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryRecord;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return { ok: true, memory };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, memoryId, toClass },
        "knowledge.memory: demoteMemoryAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to demote memory." };
    }
  });
}

// ---------------------------------------------------------------------------
// suggestRationalesAction
//
// Read-only: drafts candidate rationales for a promotion/demotion so the
// human can pick one instead of typing. Backs the RationalePicker select
// (rationale-picker.tsx) used by every promote/demote flow. No
// revalidatePath — this never mutates a memory.
// ---------------------------------------------------------------------------

export async function suggestRationalesAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  toClass: "RULE" | "FACT" | "OBSERVATION";
  count?: number;
}): Promise<SuggestRationalesResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, memoryId, toClass, count } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to view rationale suggestions.",
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
      const out = (await invoke(
        "suggest_promotion_rationales",
        { memoryId, toClass, ...(count != null ? { count } : {}) },
        ctx,
        { surface: "agent" },
      )) as { rationales: string[] };

      return { ok: true, rationales: out.rationales };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, memoryId, toClass },
        "knowledge.memory: suggestRationalesAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return {
        ok: false,
        error: message || "Failed to load rationale suggestions.",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// promotionCandidatesAction
//
// The top OBSERVATIONs by citation pressure that are ripe to promote — backs
// the "suggested to promote" panel above the memories list.
// ---------------------------------------------------------------------------

export async function promotionCandidatesAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  limit?: number;
}): Promise<PromotionCandidatesResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, limit } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to view memories.",
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
      const out = (await invoke(
        "list_memory_promotions",
        { ...(limit != null ? { limit } : {}) },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryPromotionCandidatesOutput;

      return { ok: true, candidates: out.candidates };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id },
        "knowledge.memory: promotionCandidatesAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return {
        ok: false,
        error: message || "Failed to load promotion candidates.",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// listMemoryCitationsAction
//
// Backs the Citations view: which memories were cited during an execution,
// how much each one actually shaped the output (influence), and whether any
// cited RULE was violated (compliance). agent.memory_citation.list (schema
// §7d/§7e) is scoped to a single executionId, not a single memoryId — there is
// no "citations for this memory across all executions" query — so the panel
// asks for an execution id and the caller narrows to one memory client-side
// (each citation row already carries its memoryId + lesson).
// ---------------------------------------------------------------------------

export async function listMemoryCitationsAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  executionId: string;
  compliance?: "COMPLIED" | "DISCRETION" | "VIOLATION" | "NA";
  influenceIn?: Array<"DECISIVE" | "CONTRIBUTING" | "CONSIDERED" | "IGNORED">;
}): Promise<ListMemoryCitationsResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, executionId, compliance, influenceIn } =
    input;

  const trimmedExecutionId = executionId.trim();
  if (trimmedExecutionId.length === 0) {
    return { ok: false, error: "Enter an execution id to look up citations." };
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
        error: "You must be a workspace member to view citations.",
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
      const out = (await invoke(
        "list_memory_citations",
        {
          executionId: trimmedExecutionId,
          ...(compliance ? { compliance } : {}),
          ...(influenceIn && influenceIn.length > 0 ? { influenceIn } : {}),
        },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryCitationsListOutput;

      return { ok: true, citations: out.citations };
    } catch (err) {
      logger.error(
        {
          err,
          orgId: org.id,
          workspaceId: ws.id,
          executionId: trimmedExecutionId,
        },
        "knowledge.memory: listMemoryCitationsAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to load citations." };
    }
  });
}

// ---------------------------------------------------------------------------
// attachMemoryEvidenceAction
//
// Backs the Evidence attach panel: records a corroborating (or refuting)
// :Evidence node against a memory, which moves confidence by strength*100
// (capped 100) and refreshes the decay clock (schema §5/§7b). This is how a
// memory's confidence recovers between decay passes without waiting for a
// fresh citation.
// ---------------------------------------------------------------------------

export async function attachMemoryEvidenceAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  sourceKind:
    | "CITATION"
    | "HUMAN_CONFIRM"
    | "CODE_SCAN"
    | "AGENT_JUDGE"
    | "REPEAT_OBSERVATION";
  strength: number;
  detail?: string;
  refutes?: boolean;
}): Promise<AttachMemoryEvidenceResult> {
  const session = await getSessionOrRedirect();
  const {
    orgSlug,
    workspaceSlug,
    memoryId,
    sourceKind,
    strength,
    detail,
    refutes,
  } = input;

  const trimmedMemoryId = memoryId.trim();
  if (trimmedMemoryId.length === 0) {
    return {
      ok: false,
      error: "Enter the id of the memory to attach evidence to.",
    };
  }
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    return { ok: false, error: "Strength must be between 0 and 1." };
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
        error: "You must be a workspace member to attach evidence.",
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
      const trimmedDetail = detail?.trim();
      const out = (await invoke(
        "attach_memory_evidence",
        {
          memoryId: trimmedMemoryId,
          sourceKind,
          strength,
          ...(trimmedDetail ? { detail: trimmedDetail } : {}),
          refutes: refutes ?? false,
        },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryEvidenceAttachOutput;

      // Confidence moved — revalidate the list so the row's confidence bar
      // reflects the new score on next visit.
      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return {
        ok: true,
        evidenceId: out.evidenceId,
        confidenceScore: out.confidenceScore,
      };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, memoryId: trimmedMemoryId },
        "knowledge.memory: attachMemoryEvidenceAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to attach evidence." };
    }
  });
}
