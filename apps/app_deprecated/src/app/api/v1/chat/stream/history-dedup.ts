// Pure helpers for the chat stream route, extracted so they are unit-testable
// without standing up the whole SSE handler.

/**
 * True when the newest history row IS this turn's user message, detected by
 * message id (NOT text). History rows arrive newest-first (DESC), so the current
 * turn — when `sendMessageAction` has already persisted it concurrently — is
 * `rows[0]`. The client sends the user message's id as `parentMessageId`, so an
 * id match is definitive and robust to equal text and equal `createdAt` (the
 * failure mode of a text-only comparison, which let a duplicate slip through and
 * made the model see the prompt twice).
 */
export function isCurrentUserTurnAtHead(
  rows: ReadonlyArray<{ id: string; role: string }>,
  parentMessageId: string | null,
): boolean {
  return (
    parentMessageId != null &&
    rows[0]?.role === "user" &&
    rows[0]?.id === parentMessageId
  );
}

// Engine resilience for a web chat turn. A single transient 429/5xx from the
// gateway must not kill the turn (maxRetries), and a context overflow should
// trigger the engine's compact-and-retry once rather than a hard error
// (maxOverflowRetries). The SSE translator only forwards a step's parts once it
// finishes, so a retried step never double-streams to the client.
export const CHAT_MAX_RETRIES = 2;
export const CHAT_MAX_OVERFLOW_RETRIES = 1;
