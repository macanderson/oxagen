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

/** The event the conversation titler names a new conversation on. */
export type ConversationOpenedEvent = {
  name: "chat/conversation.opened";
  data: { conversationId: string; orgId: string; workspaceId: string };
};

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
  try {
    await sender(event);
  } catch (err) {
    logger.error(
      { err, conversationId: event.data.conversationId },
      "chat/conversation.opened dispatch failed; the conversation keeps its prompt title",
    );
  }
}
