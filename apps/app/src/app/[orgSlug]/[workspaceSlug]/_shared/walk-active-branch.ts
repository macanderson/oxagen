/**
 * walk-active-branch.ts — pure helper that reconstructs the visible message
 * branch from a flat list of DB rows by walking parent links from the active
 * leaf to the root.
 *
 * Extracted from conversation-page.tsx so it can be unit-tested without
 * pulling in server-only dependencies.
 */
import type { DbMessageRow } from "@oxagen/database";
import type { ChatMessage } from "@/components/chat/chat-shell";
import type { AssistantContentBlock } from "@/components/chat/stream-event-types";

// Walk parents from the active leaf to reconstruct the visible branch.
// Falls back to the most-recent root path when no leaf is set.
export function walkActiveBranch(rows: DbMessageRow[], leafId: string | null): ChatMessage[] {
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childCount = new Map<string, number>();
  for (const r of rows) {
    if (r.parentMessageId) childCount.set(r.parentMessageId, (childCount.get(r.parentMessageId) ?? 0) + 1);
  }
  const path: DbMessageRow[] = [];
  let cursor: DbMessageRow | undefined = leafId
    ? byId.get(leafId)
    : rows.find((r) => r.parentMessageId === null);
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentMessageId ? byId.get(cursor.parentMessageId) : undefined;
  }
  return path.map((r) => {
    // Pull persisted turn usage (creditsCharged, totalTokens) out of the metadata
    // jsonb column so the assistant footer can keep showing them after a refresh.
    // The stream route writes them under `metadata.usage` when the turn completes.
    const meta = (r.metadata ?? null) as { usage?: { creditsCharged?: number; totalTokens?: number } } | null;
    const usage = meta?.usage;
    return {
      publicId: r.publicId,
      role: r.role as "user" | "assistant" | "system" | "tool",
      content: r.content,
      branchReason: r.branchReason,
      siblingCount: r.parentMessageId ? (childCount.get(r.parentMessageId) ?? 1) : 1,
      contentBlocks: Array.isArray(r.contentBlocks) ? (r.contentBlocks as AssistantContentBlock[]) : undefined,
      ...(typeof usage?.creditsCharged === "number" ? { creditsCharged: usage.creditsCharged } : {}),
      ...(typeof usage?.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    } satisfies ChatMessage;
  });
}
