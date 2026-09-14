"use server";

/**
 * bulk-import-actions.ts — server actions for the Knowledge → Memories bulk
 * import flow: parse uploaded markdown documents into draft memories, then
 * commit the (edited, confirmed) drafts into the workspace AgentMemory graph.
 *
 * Two actions back the two-stage UI:
 *   1. parseImportAction  → agent.memory.import.parse  (read-only; returns drafts)
 *   2. commitImportAction → agent.memory.import.commit (writes; per-item results)
 *
 * Both follow the identical guard pattern used by actions.ts:
 *   1. getSessionOrRedirect()      → session guard
 *   2. resolveOrg / resolveWorkspace → IDOR + org/workspace resolution
 *   3. assertOrgMember()           → org membership guard
 *   4. assertWorkspaceMember()     → workspace role guard (apps/app skips IAM, so
 *      invoke() does NOT enforce roles — we re-read the role from Postgres here)
 *   5. invoke() with surface: "agent" (agent.memory.import.* is
 *      surfaces: ["api","mcp","agent"], NOT "app")
 *   6. commit revalidatePath() → invalidate the memories list RSC
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect imports: bind every handler so invoke() can resolve.
// agent.memory.import.* handlers are bound by @oxagen/agent/register.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { withTenantDb, schema } from "@oxagen/database";
import type { MemoryImportDraftInput } from "@oxagen/oxagen/contracts/agent.memory_import.shared";
import type { AgentMemoryImportParseOutput } from "@oxagen/oxagen/contracts/agent.memory_import.parse";
import type { AgentMemoryImportCommitOutput } from "@oxagen/oxagen/contracts/agent.memory_import.commit";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Result types. A "use server" module may only EXPORT async server actions —
// re-exporting types from here breaks the Next server-actions transform (it
// registers every export as an action ref, but types are erased at runtime).
// So the client component declares its own structural draft type (DraftMemory
// in memories-bulk-import.tsx); these Result aliases are local-only helpers.
// ---------------------------------------------------------------------------

type ParseImportResult =
  | {
      ok: true;
      drafts: AgentMemoryImportParseOutput["drafts"];
      documentCount: number;
      skipped: AgentMemoryImportParseOutput["skipped"];
    }
  | { ok: false; error: string };

export type CommitImportResult =
  | {
      ok: true;
      results: AgentMemoryImportCommitOutput["results"];
      imported: number;
      failed: number;
    }
  | { ok: false; error: string };

// A single uploaded document as the client hands it over (filename + raw text).
interface UploadedDocument {
  filename: string;
  content: string;
}

// Contract caps, mirrored client-side for friendly pre-flight errors. Kept in
// sync with agent.memory.import.parse / .commit inputs.
const MAX_DOCS_PER_CALL = 25;
const MAX_DRAFTS_PER_CALL = 200;
const MAX_DOC_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Shared IAM helper — apps/app never bootstraps IAM, so invoke() skips role
// checks in the app surface. Re-read the caller's workspace role from Postgres
// before parsing or committing. parse and commit both allow Owners + Members
// (mirrors the contract defaultRoles).
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
// parseImportAction
//
// Stage 1: extract editable draft memories from uploaded markdown documents.
// Read-only — runs classification via the AI gateway and returns drafts; it
// writes nothing to the graph (commit does), so there is no revalidatePath here.
// ---------------------------------------------------------------------------

export async function parseImportAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  documents: UploadedDocument[];
  defaultNodeRef?: string;
}): Promise<ParseImportResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, documents, defaultNodeRef } = input;

  // Drop blank documents and trim filenames before the cap check so an empty
  // upload slot never burns a slot or fails the batch.
  const cleaned = documents
    .map((d) => ({
      filename: d.filename.trim().slice(0, 256),
      content: d.content,
    }))
    .filter((d) => d.filename.length > 0 && d.content.trim().length > 0);

  if (cleaned.length === 0) {
    return {
      ok: false,
      error: "Upload at least one non-empty markdown document.",
    };
  }
  if (cleaned.length > MAX_DOCS_PER_CALL) {
    return {
      ok: false,
      error: `Too many documents — import at most ${MAX_DOCS_PER_CALL} at a time.`,
    };
  }
  const tooLong = cleaned.find((d) => d.content.length > MAX_DOC_CHARS);
  if (tooLong) {
    return {
      ok: false,
      error: `"${tooLong.filename}" is too large (max ${MAX_DOC_CHARS.toLocaleString()} characters).`,
    };
  }

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // IDOR guard: caller must be an org member.
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to import memories.",
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
      const trimmedRef = defaultNodeRef?.trim();
      const out = (await invoke(
        "parse_memory_import",
        {
          documents: cleaned,
          ...(trimmedRef ? { defaultNodeRef: trimmedRef } : {}),
        },
        ctx,
        { surface: "agent" },
      )) as AgentMemoryImportParseOutput;

      return {
        ok: true,
        drafts: out.drafts,
        documentCount: out.documentCount,
        skipped: out.skipped,
      };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, documents: cleaned.length },
        "knowledge.memory: parseImportAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to parse documents." };
    }
  });
}

// ---------------------------------------------------------------------------
// commitImportAction
//
// Stage 2: write the confirmed drafts into the AgentMemory graph. Per-item
// error capture — one bad row never fails the batch — so the result array is
// positional and the UI reconciles by index. Revalidates the list so the new
// memories appear immediately.
// ---------------------------------------------------------------------------

export async function commitImportAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  drafts: MemoryImportDraftInput[];
}): Promise<CommitImportResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, drafts } = input;

  if (drafts.length === 0) {
    return { ok: false, error: "Select at least one memory to import." };
  }
  if (drafts.length > MAX_DRAFTS_PER_CALL) {
    return {
      ok: false,
      error: `Too many memories — import at most ${MAX_DRAFTS_PER_CALL} at a time.`,
    };
  }

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const gate = await assertWorkspaceMember(ws.id, session.user.id);
    if (gate === "denied") {
      return {
        ok: false,
        error: "You must be a workspace member to import memories.",
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
      const out = (await invoke("commit_memory_import", { drafts }, ctx, {
        surface: "agent",
      })) as AgentMemoryImportCommitOutput;

      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/memory`);
      return {
        ok: true,
        results: out.results,
        imported: out.imported,
        failed: out.failed,
      };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, drafts: drafts.length },
        "knowledge.memory: commitImportAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to import memories." };
    }
  });
}
