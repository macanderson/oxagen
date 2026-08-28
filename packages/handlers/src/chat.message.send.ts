import type { CapabilityHandler } from "@oxagen/oxagen";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import { logger } from "./logger";

/**
 * Persists the user turn and a placeholder assistant message (metadata:
 * { status: "pending" }), then returns their ids. It does not call the model
 * or dispatch any background job. The LLM call and streaming happen in the
 * stream route (POST /api/v1/chat/stream), which is the single LLM caller
 * per turn and persists the assistant reply directly once the stream
 * finishes.
 *
 * For new conversations with a non-empty first message, a title is
 * generated asynchronously using generateObjectFor. This happens in the
 * background and doesn't block the message send response.
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
    let isNewConversation = false;
    if (!conversationId) {
      const [conv] = await tx
        .insert(schema.conversations)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId!,
          title: null,
          status: "active",
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({ id: schema.conversations.id });
      if (!conv) throw new Error("conversation insert returned no row");
      conversationId = conv.id;
      isNewConversation = true;
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
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
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
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
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
      isNewConversation,
    };
  });

  // After persisting the message, asynchronously generate a title for new conversations
  // with a non-empty message. This runs outside the transaction so it doesn't block
  // the message persistence, and only happens once per conversation.
  if (result.isNewConversation && input.content.trim()) {
    generateConversationTitleAsync(
      result.conversationId,
      input.content,
      ctx.orgId,
      ctx.workspaceId,
      ctx.userId!,
    ).catch((err) => {
      logger.error(
        { conversationId: result.conversationId, err, orgId: ctx.orgId },
        "chat.message.send: title generation failed",
      );
      // Swallow the error — title generation failure must not fail the message send.
    });
  }

  return {
    conversationId: result.conversationId,
    userMessageId: result.userMessageId,
    assistantMessageId: result.assistantMessageId,
    activeLeafMessageId: result.activeLeafMessageId,
  };
};

async function generateConversationTitleAsync(
  conversationId: string,
  userMessage: string,
  orgId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    const titleSchema = z.object({
      title: z
        .string()
        .describe("A concise 3-8 word title for this conversation"),
    });

    const { object } = await generateObjectFor({
      schema: titleSchema,
      prompt: `Generate a concise 3-8 word title for a conversation that starts with: "${userMessage.substring(0, 200)}"`,
      telemetry: {
        orgId,
        workspaceId,
        surface: "runner",
        messageId: conversationId,
      },
    });

    // Update the conversation with the generated title
    await withTenantDb(async (tx) => {
      await tx
        .update(schema.conversations)
        .set({
          title: object.title,
          updatedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(eq(schema.conversations.id, conversationId));
    });

    logger.info(
      { conversationId, title: object.title, orgId },
      "chat.message.send: conversation title generated",
    );
  } catch (err) {
    // Log the error but don't throw — title generation is best-effort
    logger.error(
      { conversationId, err, orgId },
      "chat.message.send: failed to generate conversation title",
    );
  }
}
