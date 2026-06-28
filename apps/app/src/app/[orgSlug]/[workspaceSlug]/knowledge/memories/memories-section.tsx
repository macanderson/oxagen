/**
 * memories-section.tsx — Async server component that fetches AgentMemory
 * records from Neo4j via agent.memory.list and passes them to MemoriesClient.
 *
 * Sits inside a <Suspense> boundary so the page skeleton shows immediately.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AgentMemoryRecord } from "@oxagen/oxagen/contracts/agent.memory.list";
import { MemoriesClient } from "@/components/knowledge/memories/memories-client";

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
          "agent.memory.list",
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
    />
  );
}
