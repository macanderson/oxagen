/**
 * `chat/conversation.opened` for a conversation named from its first question
 * (#4571).
 *
 * A new conversation takes its title from the first question when its row is
 * written, so the session list never shows "Untitled session" for a question
 * with words in it. The fast model tier may then write a better subject in the
 * background (`conversation.title` in `@oxagen/inngest-functions`), and this
 * event asks it to. The event carries ids only; the function reads the
 * question back inside the tenant scope, so no user text goes to the event
 * bus.
 *
 * The event client lives in `@oxagen/inngest-functions`, which depends on this
 * package, so this package cannot import it. `@oxagen/handlers/register`
 * installs the sender at boot, the same way it installs the run-sealed one
 * (`run-sealed-event.ts`).
 *
 * Sending is best-effort. The conversation has committed with its prompt
 * title by then, so a missing sender or a failed send is logged, the prompt
 * title stays, and the turn goes on.
 */
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.conversation-opened-event" },
});

/**
 * The event the conversation titler names a new conversation on. `id` is the
 * dedup key the sender sets (`conversationOpenedEventId`).
 */
export type ConversationOpenedEvent = {
  name: "chat/conversation.opened";
  data: { conversationId: string; orgId: string; workspaceId: string };
  id?: string;
};

/**
 * One key per conversation. A conversation opens once, so the event bus drops
 * a repeat send inside its dedup window (24 hours on Inngest), and a retried
 * turn does not pay for a second title call.
 */
export function conversationOpenedEventId(conversationId: string): string {
  return `chat/conversation.opened:${conversationId}`;
}

export type ConversationOpenedSender = (
  event: ConversationOpenedEvent,
) => Promise<void>;

let sender: ConversationOpenedSender | null = null;

/** Install the sender at surface boot; null removes it (tests). */
export function setConversationOpenedSender(
  next: ConversationOpenedSender | null,
): void {
  sender = next;
}

/**
 * How long a turn waits for the event bus to accept `chat/conversation.opened`.
 * The title is optional, so a slow bus costs the conversation its model title
 * at worst, never the turn.
 */
export const CONVERSATION_OPENED_SEND_TIMEOUT_MS = 2_000;

/**
 * Send `chat/conversation.opened` for a conversation whose row has committed
 * with a prompt title. Never throws: a missing sender or a failed send is
 * logged, and the conversation keeps its prompt title.
 */
export async function sendConversationOpened(
  event: ConversationOpenedEvent,
): Promise<void> {
  if (sender === null) {
    logger.warn(
      { conversationId: event.data.conversationId },
      "no conversation-opened sender is installed; the conversation keeps its prompt title",
    );
    return;
  }
  // Both callers await this on a new conversation's first turn, so a stalled
  // event bus would hold the turn. The title is optional, so the wait is
  // bounded: past the limit the turn goes on, and a send that lands later
  // still names the conversation.
  const install = sender;
  const sent = Promise.resolve()
    .then(() =>
      install({
        ...event,
        id: conversationOpenedEventId(event.data.conversationId),
      }),
    )
    .then(
      () => "sent" as const,
      (err: unknown) => {
        logger.error(
          { err, conversationId: event.data.conversationId },
          "chat/conversation.opened dispatch failed; the conversation keeps its prompt title",
        );
        return "failed" as const;
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(
      () => resolve("timed_out"),
      CONVERSATION_OPENED_SEND_TIMEOUT_MS,
    );
  });
  const outcome = await Promise.race([sent, timedOut]);
  clearTimeout(timer);
  if (outcome === "timed_out") {
    logger.warn(
      {
        conversationId: event.data.conversationId,
        timeoutMs: CONVERSATION_OPENED_SEND_TIMEOUT_MS,
      },
      "chat/conversation.opened dispatch is slow; the turn goes on with the prompt title",
    );
  }
}
