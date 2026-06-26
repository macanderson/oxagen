/**
 * memories-section.tsx — Async server component that fetches Engram records
 * and passes them to MemoriesClient for interactive display.
 *
 * Sits inside a <Suspense> boundary so the page skeleton shows immediately.
 */
import { createStore } from "@oxagen/engram";
import type { MemoryRecord, RecordKind } from "@oxagen/engram";
import { MemoriesClient } from "@/components/knowledge/memories/memories-client";

interface MemoriesSectionProps {
  orgId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  kindFilter?: string;
  minSalience?: number;
}

export async function MemoriesSection({
  orgId,
  workspaceId,
  orgSlug,
  workspaceSlug,
  kindFilter,
  minSalience,
}: MemoriesSectionProps) {
  let records: MemoryRecord[] = [];

  try {
    const store = createStore();
    records = await store.query({
      namespace: { org: orgId, workspace: workspaceId },
      kinds: kindFilter ? [kindFilter as RecordKind] : undefined,
      minSalience: minSalience ?? undefined,
      limit: 100,
    });
    await store.close();
  } catch (e) {
    console.error("engram.query failed:", e);
    // Render empty state on failure — never throw from RSC
  }

  // Serialize records for the client (strip Int8Array embedding for transfer)
  const serialized = records.map((r) => ({
    ...r,
    embedding: undefined,
    body: r.body as Record<string, unknown>,
    provenance: r.provenance,
  }));

  return (
    <MemoriesClient
      initialRecords={serialized}
      orgId={orgId}
      workspaceId={workspaceId}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
