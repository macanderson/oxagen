// A page may offer a request for review in the assistant composer. Opening a
// draft never sends a turn, spends money, or changes a finding's status.
export const ASSISTANT_DRAFT_EVENT = "oxagen:assistant-draft";
// Matches the assistant input contract in chat.message.send.ts.
export const ASSISTANT_CONTENT_MAX = 32_768;
export const ASSISTANT_DRAFT_MAX = 16_000;

export type AssistantDraft = { org: string; ws: string; content: string };

export function openAssistantDraft(draft: AssistantDraft): void {
  window.dispatchEvent(
    new CustomEvent(ASSISTANT_DRAFT_EVENT, { detail: draft }),
  );
}

export function assistantDraftOf(event: Event): AssistantDraft | null {
  if (!(event instanceof CustomEvent)) return null;
  const value: unknown = event.detail;
  if (typeof value !== "object" || value === null) return null;
  if (!("org" in value) || !("ws" in value) || !("content" in value))
    return null;
  if (
    typeof value.org !== "string" ||
    typeof value.ws !== "string" ||
    typeof value.content !== "string"
  )
    return null;
  if (
    !value.org ||
    !value.ws ||
    !value.content.trim() ||
    value.content.length > ASSISTANT_DRAFT_MAX
  )
    return null;
  return { org: value.org, ws: value.ws, content: value.content };
}
