// The conversations port on the kernel (ARCHITECTURE.md §3.3): the viewer's
// latest assistant thread in a workspace, read back through
// `get_conversation` so the flyout shows the thread a reload left (#4163).
import "server-only";
import {
  conversationGet,
  type ConversationGetOutput,
} from "@oxagen/oxagen/contracts/conversation.get";
import { captureError } from "@oxagen/telemetry";
import {
  AssistantThread,
  type ThreadMessage,
} from "@/data/contracts/conversations";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";

/** The newest messages a reopened thread shows: fifty turns. */
const THREAD_MESSAGES = 100;

type StoredConversation = NonNullable<ConversationGetOutput["conversation"]>;
type StoredMessage = StoredConversation["messages"][number];

/**
 * A stored message as the flyout draws it. A `system` row is the model's
 * instruction, not something the person said or read, so it is left out.
 *
 * The contract names the engine's own call id `toolCallId`, which is what the
 * engine calls it; the view model carries it as `toolCallRef`, because it is
 * not an id Oxagen mints (INV-11). This is the one place the two names meet.
 */
function toThreadMessage(message: StoredMessage): ThreadMessage | null {
  if (message.role === "system") return null;
  return {
    id: message.publicId,
    role: message.role,
    text: message.content,
    runId: message.runId,
    parked: message.parkedCards,
    toolCalls: message.toolCalls.map((call) => ({
      toolCallRef: call.toolCallId,
      toolName: call.toolName,
      outcome: call.outcome,
      durationMs: call.durationMs,
      approvalId: call.approvalId,
    })),
    stopped: message.stopped,
  };
}

function toAssistantThread(conversation: StoredConversation): unknown {
  return {
    id: conversation.publicId,
    messages: conversation.messages
      .map(toThreadMessage)
      .filter((m) => m !== null),
    truncated: conversation.truncated,
  };
}

export const conversations: DataSource["conversations"] = {
  async latest(ctx) {
    const read = await kernelRead(ctx, {
      contract: conversationGet,
      input: { conversationId: null, limit: THREAD_MESSAGES },
      page: "shell",
    });
    if (!read.ok) return read;
    const { conversation } = read.value;
    if (conversation === null) return readOk(null);
    const view = AssistantThread.safeParse(toAssistantThread(conversation));
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "conversations.latest record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },
};
