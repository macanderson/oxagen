import type { CapabilityHandler } from "@oxagen/oxagen";
import { chatMessageSend } from "@oxagen/oxagen/capabilities/chat.message.send";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

/**
 * Foundation-milestone variant: persists the user turn and a placeholder
 * assistant message, then dispatches an Inngest event for the runner to
 * stream tokens into the assistant row. The streaming surface (SSE/RSC)
 * lives at the route layer; this handler returns terminal ids so the
 * route can subscribe to updates.
 *
 * The Vercel AI SDK integration lands with the agent epic — wiring the
 * trigger here keeps the contract stable so UI work can proceed against
 * the right shape today.
 */
export const chatMessageSendHandler: CapabilityHandler<typeof chatMessageSend> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) throw new Error("chat.message.send requires an authenticated user");
  const d = db();

  return await d.transaction(async (tx) => {
    // 1. Resolve or create the conversation.
    let conversationId = input.conversationId;
    if (!conversationId) {
      const [conv] = await tx
        .insert(schema.conversations)
        .values({
          tenantId: ctx.tenantId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId!,
          agentVersionId: input.agentVersionId,
          title: null,
          status: "active",
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({ id: schema.conversations.id });
      if (!conv) throw new Error("conversation insert returned no row");
      conversationId = conv.id;
    } else {
      // Confirm the conversation belongs to this tenant. Cross-tenant
      // lookup would be a leak; the tenant scope is part of the index.
      const exists = await tx.query.conversations.findFirst({
        where: and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.tenantId, ctx.tenantId),
        ),
        columns: { id: true },
      });
      if (!exists) throw new Error("conversation not found in this tenant");
    }

    // 2. Persist the user message.
    const [userMessage] = await tx
      .insert(schema.messages)
      .values({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        conversationId,
        parentMessageId: input.parentMessageId,
        role: "user",
        content: input.content,
        contentBlocks: input.contentBlocks,
        branchReason: input.branchReason,
        isActiveInBranch: true,
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
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        conversationId,
        parentMessageId: userMessage.id,
        role: "assistant",
        content: "",
        contentBlocks: [],
        branchReason: null,
        isActiveInBranch: true,
        metadata: { status: "pending" },
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning({ id: schema.messages.id });
    if (!assistantMessage) throw new Error("assistant message insert returned no row");

    await tx
      .update(schema.conversations)
      .set({ activeLeafMessageId: assistantMessage.id, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    return {
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      activeLeafMessageId: assistantMessage.id,
    };
  });
};
