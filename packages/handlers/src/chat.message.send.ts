import type { CapabilityHandler } from "@oxagen/oxagen";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { sendConversationOpened } from "@oxagen/agent/runtime/conversation-opened-event";
import { schema, withTenantDb } from "@oxagen/database";
import { sessionSubject } from "@oxagen/tacho/session-subject";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Persists the user turn and a placeholder assistant message (metadata:
 * { status: "pending" }), then returns their ids. It does not call the
 * model. The LLM call and streaming happen in the
 * stream route (POST /api/v1/chat/stream), which is the single LLM caller
 * per turn and persists the assistant reply directly once the stream
 * finishes.
 *
 * A new conversation is named from its first message when its row is
 * written: a subject of at most 72 characters (`sessionSubject`), marked
 * `title_source = 'prompt'`. After the commit, `chat/conversation.opened`
 * asks the fast model tier for a better subject in the background. A message
 * with no words in it leaves the title null and sends nothing.
 */
export const chatMessageSendHandler: CapabilityHandler<
  typeof chatMessageSend
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "chat.message.send: rejected — no authenticated user",
    );
    throw new Error("chat.message.send requires an authenticated user");
  }

  const result = await withTenantDb(async (tx) => {
    // 1. Resolve or create the conversation.
    let conversationId = input.conversationId;
    let promptTitled = false;
    if (!conversationId) {
      const title = sessionSubject(input.content);
      const [conv] = await tx
        .insert(schema.conversations)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId!,
          title,
          titleSource: title === null ? null : "prompt",
          status: "active",
          createdById: ctx.userId,
          updatedById: ctx.userId,
        })
        .returning({ id: schema.conversations.id });
      if (!conv) throw new Error("conversation insert returned no row");
      conversationId = conv.id;
      promptTitled = title !== null;
    } else {
      // Confirm the conversation belongs to this tenant. Cross-tenant
      // lookup would be a leak; the tenant scope is part of the index.
      const exists = await tx.query.conversations.findFirst({
        where: and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.orgId, ctx.orgId),
        ),
        columns: { id: true },
      });
      if (!exists) throw new Error("conversation not found in this tenant");
    }

    // 2. Persist the user message.
    const [userMessage] = await tx
      .insert(schema.messages)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        conversationId,
        parentMessageId: input.parentMessageId,
        role: "user",
        content: input.content,
        contentBlocks: input.contentBlocks,
        branchReason: input.branchReason,
        metadata: {},
        createdById: ctx.userId,
        updatedById: ctx.userId,
      })
      .returning({ id: schema.messages.id });
    if (!userMessage) throw new Error("user message insert returned no row");

    // 3. Placeholder assistant row — streamed tokens are appended by the
    // runner; the active_leaf pointer follows the assistant row so the
    // UI walks from there back to the root.
    const [assistantMessage] = await tx
      .insert(schema.messages)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        conversationId,
        parentMessageId: userMessage.id,
        role: "assistant",
        content: "",
        contentBlocks: [],
        branchReason: null,
        metadata: { status: "pending" },
        createdById: ctx.userId,
        updatedById: ctx.userId,
      })
      .returning({ id: schema.messages.id });
    if (!assistantMessage)
      throw new Error("assistant message insert returned no row");

    await tx
      .update(schema.conversations)
      .set({ activeLeafMessageId: assistantMessage.id, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    logger.info(
      {
        conversationId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
      },
      "chat.message.send: message persisted successfully",
    );
    return {
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      activeLeafMessageId: assistantMessage.id,
      promptTitled,
    };
  });

  // Sent after the commit, so the titler can read the row. Never throws.
  if (result.promptTitled) {
    await sendConversationOpened({
      name: "chat/conversation.opened",
      data: {
        conversationId: result.conversationId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      },
    });
  }

  return {
    conversationId: result.conversationId,
    userMessageId: result.userMessageId,
    assistantMessageId: result.assistantMessageId,
    activeLeafMessageId: result.activeLeafMessageId,
  };
};
