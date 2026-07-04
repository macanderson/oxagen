/**
 * walk-active-branch.ts — pure helper that reconstructs the visible message
 * branch from a flat list of DB rows by walking parent links from the active
 * leaf to the root.
 *
 * Extracted from conversation-page.tsx so it can be unit-tested without
 * pulling in server-only dependencies.
 */
import type { DbMessageRow } from "@oxagen/database";
import type { ChatMessage, MessageAttachment } from "@/components/chat/chat-shell";
import type { AssistantContentBlock } from "@/components/chat/stream-event-types";

/**
 * Extract `metadata.attachments` (persisted by sendMessageAction/wandSendAction
 * for a user turn — see chat/actions.ts) as a validated `MessageAttachment[]`.
 * Defensive: an absent field, a malformed row, or a row from before this
 * feature shipped all fall back to `undefined` rather than throwing.
 */
function attachmentsFromMetadata(metadata: unknown): MessageAttachment[] | undefined {
  if (!metadata || typeof metadata !== "object" || !("attachments" in metadata)) return undefined;
  const raw = (metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const valid = raw.filter(
    (a): a is MessageAttachment =>
      !!a &&
      typeof a === "object" &&
      typeof (a as MessageAttachment).publicId === "string" &&
      typeof (a as MessageAttachment).kind === "string" &&
      typeof (a as MessageAttachment).name === "string" &&
      typeof (a as MessageAttachment).mimeType === "string" &&
      typeof (a as MessageAttachment).url === "string",
  );
  return valid.length > 0 ? valid : undefined;
}

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
  return path.map((r) => ({
    publicId: r.publicId,
    role: r.role as "user" | "assistant" | "system" | "tool",
    content: r.content,
    branchReason: r.branchReason,
    siblingCount: r.parentMessageId ? (childCount.get(r.parentMessageId) ?? 1) : 1,
    contentBlocks: Array.isArray(r.contentBlocks) ? (r.contentBlocks as AssistantContentBlock[]) : undefined,
    attachments: attachmentsFromMetadata(r.metadata),
  }));
}
