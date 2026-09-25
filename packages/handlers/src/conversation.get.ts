// conversation.get.ts: `get_conversation`, one of the caller's conversations
// with its messages, read back so a surface can show the thread it left
// (#4163). The app's assistant flyout reads the latest one when it opens, so a
// reload shows the thread the person was in.
//
// Ownership is the rule the other conversation handlers apply
// (conversation.list, .rename, .archive, .delete): the row is in this org and
// workspace, belongs to the person asking, and is not deleted. A row that
// fails it is `not_found`, the same answer as a row that does not exist, so
// the read confirms nothing about someone else's conversation. The person is
// the signed-in user or, for an API key, its creator (resolveActingUserId),
// the same person `ask_assistant` records a key's turns under.
//
// Each reply's `toolCalls` is read from its run in the ledger, the one record
// of what the turn called, with the builder `ask_assistant` uses. Nothing is
// copied onto the message. One ledger read answers every reply returned.
import type { CapabilityHandler, CheckedContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { assistantParkedCardSchema } from "@oxagen/oxagen/contracts/assistant.ask";
import {
  conversationGet,
  type ConversationGetInput,
  type ConversationGetOutput,
  type ConversationMessage,
} from "@oxagen/oxagen/contracts/conversation.get";
import { ASSISTANT_MESSAGE_STOPPED } from "@oxagen/agent/runtime/assistant-message-status";
import { toolCallsFromLedger } from "@oxagen/agent/runtime/assistant-tool-calls";
import { schema, withTenantDb } from "@oxagen/database";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import type { RunStore, RunToolCallRecord } from "@oxagen/run-ledger";
import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm";
import { walkActiveBranch } from "./lib/conversation-markdown";
import { ledgerStore } from "./lib/run-read";
import { logger } from "./logger";

const ROLES = new Set<ConversationMessage["role"]>([
  "user",
  "assistant",
  "system",
]);

type MessageRow = {
  id: string;
  publicId: string;
  parentMessageId: string | null;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
};

/** A message as the conversation store holds it, before its tool calls. */
type StoredMessage = Omit<ConversationMessage, "toolCalls">;

export interface ConversationGetDeps {
  /** The run ledger's read of many runs' tool calls in one query. */
  readToolCallsForRuns: RunStore["readToolCallsForRuns"];
}

export function createConversationGetHandler(
  deps: ConversationGetDeps,
): CapabilityHandler<typeof conversationGet> {
  return (input, ctx) => getConversation(deps, input, ctx);
}

async function getConversation(
  deps: ConversationGetDeps,
  input: ConversationGetInput,
  ctx: CheckedContext,
): Promise<ConversationGetOutput> {
  const userId = await resolveActingUserId(ctx);
  if (!userId) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }

  const owned: SQL[] = [
    eq(schema.conversations.orgId, ctx.orgId),
    eq(schema.conversations.workspaceId, ctx.workspaceId),
    eq(schema.conversations.userId, userId),
    isNull(schema.conversations.deletedAt),
  ];
  // A named conversation may be archived: it is still the person's to read.
  // With no id, the flyout wants the thread it last used, which is active.
  const which: SQL[] =
    input.conversationId === null
      ? [isNull(schema.conversations.archivedAt)]
      : [eq(schema.conversations.publicId, input.conversationId)];

  const result = await withTenantDb(async (tx) => {
    const [conversation] = await tx
      .select({
        id: schema.conversations.id,
        publicId: schema.conversations.publicId,
        title: schema.conversations.title,
        status: schema.conversations.status,
        archivedAt: schema.conversations.archivedAt,
        createdAt: schema.conversations.createdAt,
        updatedAt: schema.conversations.updatedAt,
        activeLeafMessageId: schema.conversations.activeLeafMessageId,
      })
      .from(schema.conversations)
      .where(and(...owned, ...which))
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(1);
    if (!conversation) return null;
    const rows: MessageRow[] = await tx
      .select({
        id: schema.messages.id,
        publicId: schema.messages.publicId,
        parentMessageId: schema.messages.parentMessageId,
        role: schema.messages.role,
        content: schema.messages.content,
        metadata: schema.messages.metadata,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversation.id),
          eq(schema.messages.orgId, ctx.orgId),
          eq(schema.messages.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(asc(schema.messages.createdAt));
    return { conversation, rows };
  });

  if (result === null) {
    if (input.conversationId === null) {
      return { conversation: null };
    }
    logger.warn(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        conversationId: input.conversationId,
      },
      "conversation.get: conversation not found or not the caller's",
    );
    throw new HandlerError({
      code: "not_found",
      reason: "conversation_not_found",
    });
  }

  const { conversation, rows } = result;
  const thread = walkActiveBranch(rows, conversation.activeLeafMessageId)
    .map(toMessage)
    .filter((m): m is StoredMessage => m !== null);
  const page = thread.slice(-input.limit);
  const truncated = page.length < thread.length;
  const callsByRun = await readReplyToolCalls(deps, page, ctx);
  const messages: ConversationMessage[] = page.map((message) => ({
    ...message,
    toolCalls:
      message.role === "assistant" && message.runId !== null
        ? toolCallsFromLedger(
            callsByRun.get(message.runId) ?? [],
            message.parkedCards,
          )
        : [],
  }));

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      publicId: conversation.publicId,
      messageCount: messages.length,
      truncated,
      surface: ctx.surface,
    },
    "conversation.get: returned conversation",
  );

  return {
    conversation: {
      publicId: conversation.publicId,
      title: conversation.title ?? null,
      status: conversation.status,
      archivedAt: conversation.archivedAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages,
      truncated,
    },
  };
}

const ledger = ledgerStore();

export const conversationGetHandler = createConversationGetHandler({
  readToolCallsForRuns: (runPublicIds) =>
    ledger.readToolCallsForRuns(runPublicIds),
});

/**
 * The ledger's tool calls for every reply returned, in one read. A
 * failed read answers no calls rather than failing the thread: the messages
 * are still the person's to read, and a reply with an empty list shows as it
 * did before replies listed their calls. The failure is logged with its
 * error so it is not silent.
 */
async function readReplyToolCalls(
  deps: ConversationGetDeps,
  messages: readonly StoredMessage[],
  ctx: { orgId: string; workspaceId: string },
): Promise<ReadonlyMap<string, RunToolCallRecord[]>> {
  const runIds = [
    ...new Set(
      messages.flatMap((m) =>
        m.role === "assistant" && m.runId !== null ? [m.runId] : [],
      ),
    ),
  ];
  if (runIds.length === 0) return new Map();
  try {
    return await deps.readToolCallsForRuns(runIds);
  } catch (err) {
    logger.warn(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        runCount: runIds.length,
      },
      "conversation.get: could not read the replies' tool calls from the run ledger; each reply lists none",
    );
    return new Map();
  }
}

/**
 * One row as the contract states it, or null for a role no thread carries (a
 * `tool` row the deprecated chat wrote). The assistant's own history loader
 * skips the same rows, so the reader sees the transcript the model saw.
 */
function toMessage(row: MessageRow): StoredMessage | null {
  if (!ROLES.has(row.role as ConversationMessage["role"])) return null;
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return {
    publicId: row.publicId,
    role: row.role as ConversationMessage["role"],
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    runId: typeof metadata.runId === "string" ? metadata.runId : null,
    parkedCards: parkedCardsOf(metadata.parkedCards),
    // `appendAssistantMessage` saves a reply the person stopped with this status (#4164).
    stopped: metadata.status === ASSISTANT_MESSAGE_STOPPED,
  };
}

/**
 * The parked writes an assistant turn stored on its reply. A card that does
 * not parse is dropped and logged rather than failing the read: the rest of
 * the thread is still the person's to see.
 */
function parkedCardsOf(stored: unknown): ConversationMessage["parkedCards"] {
  if (!Array.isArray(stored)) return [];
  const cards: ConversationMessage["parkedCards"] = [];
  for (const candidate of stored) {
    const parsed = assistantParkedCardSchema.safeParse(candidate);
    if (parsed.success) {
      cards.push(parsed.data);
    } else {
      logger.warn(
        { issues: parsed.error.issues.length },
        "conversation.get: dropped a stored parked card that does not parse",
      );
    }
  }
  return cards;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
