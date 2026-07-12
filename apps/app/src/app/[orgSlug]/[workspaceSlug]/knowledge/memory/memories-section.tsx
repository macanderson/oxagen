/**
 * memories-section.tsx — Async server component that fetches AgentMemory
 * records from Neo4j via agent.memory.list and passes them to MemoriesClient.
 *
 * Sits inside a <Suspense> boundary so the page skeleton shows immediately.
 *
 * Server actions for edit/delete are imported here and passed as props to
 * MemoriesClient — the standard Next.js pattern for threading server actions
 * into client components via a server intermediary.
 */
import "@oxagen/handlers/register";
// agent.memory.list is an agent.* capability — its handler is bound by
// @oxagen/agent/register, NOT the foundation register. Without this the kernel
// throws "No handler registered for capability agent.memory.list" at runtime.
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentMemoryRecord } from "@oxagen/oxagen/contracts/agent.memory.list";
import { MemoriesClient } from "@/components/knowledge/memories/memories-client";
import {
  createMemoryAction,
  updateMemoryAction,
  deleteMemoryAction,
  promoteMemoryAction,
  promotionCandidatesAction,
} from "./actions";
import { parseImportAction, commitImportAction } from "./bulk-import-actions";

interface MemoriesSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export async function MemoriesSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: MemoriesSectionProps) {
  let memories: AgentMemoryRecord[] = [];
  let total = 0;

  try {
    const result = (await runInTenantScope(
      { orgId, workspaceId },
      () =>
        invoke(
          "list_memories",
          { limit: 100, offset: 0 },
          {
            orgId,
            workspaceId,
            userId,
            apiKeyId: null as string | null,
            requestId: crypto.randomUUID(),
            surface: "app" as const,
            messageId: null as string | null,
          },
          { surface: "agent" },
        ),
    )) as { memories: AgentMemoryRecord[]; total: number };
    memories = result.memories;
    total = result.total;
  } catch (e) {
    console.error("agent.memory.list failed:", e);
    // Render empty state on failure — never throw from RSC
  }

  return (
    <MemoriesClient
      initialRecords={memories}
      total={total}
      orgId={orgId}
      workspaceId={workspaceId}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      createMemory={createMemoryAction}
      updateMemory={updateMemoryAction}
      deleteMemory={deleteMemoryAction}
      promoteMemory={promoteMemoryAction}
      promotionCandidates={promotionCandidatesAction}
      parseImport={parseImportAction}
      commitImport={commitImportAction}
    />
  );
}
