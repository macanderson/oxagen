// The conversations port on the kernel (ARCHITECTURE.md §3.3): the viewer's
// latest assistant thread in a workspace, read back through
// `get_conversation` so the flyout shows the thread a reload left (#4163),
// and the viewer's active conversations through `list_conversations`, the
// flyout's session list, with any one of them opened by id (#4435).
import "server-only";
import {
  conversationGet,
  type ConversationGetOutput,
} from "@oxagen/oxagen/contracts/conversation.get";
import { conversationList } from "@oxagen/oxagen/contracts/conversation.list";
import { captureError } from "@oxagen/telemetry";
import {
  AssistantSession,
  AssistantThread,
  type ThreadMessage,
} from "@/data/contracts/conversations";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";

// The port names the viewer context; a live adapter may not import the viewer.
type WsCtx = Parameters<DataSource["conversations"]["latest"]>[0];

/** The newest messages a reopened thread shows: fifty turns. */
const THREAD_MESSAGES = 100;

/**
 * The sessions the list shows. The sweep archives a conversation after at
 * most a year idle, and a person who has fifty live sessions in one
 * workspace finds the one they want by its title, not by paging.
 */
const SESSION_ROWS = 50;

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

/** A stored conversation as a thread, or record_unmappable, reported once. */
function threadView(
  ctx: WsCtx,
  conversation: StoredConversation,
  method: "latest" | "byId",
) {
  const view = AssistantThread.safeParse(toAssistantThread(conversation));
  if (view.success) return readOk(view.data);
  captureError({
    error: view.error,
    source: "app",
    orgId: ctx.orgId,
    context: `conversations.${method} record_unmappable`,
  });
  return readError("record_unmappable", 502);
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
    return threadView(ctx, conversation, "latest");
  },

  async list(ctx) {
    const read = await kernelRead(ctx, {
      contract: conversationList,
      input: { filter: "active", limit: SESSION_ROWS, cursor: null },
      page: "shell",
    });
    if (!read.ok) return read;
    const view = AssistantSession.array().safeParse(
      read.value.conversations.map((row) => ({
        id: row.publicId,
        title: row.title,
        updatedAt: row.updatedAt,
      })),
    );
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "conversations.list record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },

  async byId(ctx, conversationId) {
    const read = await kernelRead(ctx, {
      contract: conversationGet,
      input: { conversationId, limit: THREAD_MESSAGES },
      page: "shell",
    });
    if (!read.ok) return read;
    const { conversation } = read.value;
    // The handler refuses an id it cannot find rather than answering null,
    // so a null here is a contract the handler broke.
    if (conversation === null) return readError("conversation_not_found", 404);
    return threadView(ctx, conversation, "byId");
  },
};
