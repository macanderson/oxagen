import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationList } from "@oxagen/oxagen/contracts/conversation.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { logger } from "./logger";

export const conversationListHandler: CapabilityHandler<
  typeof conversationList
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "conversation.list: rejected — no authenticated user",
    );
    throw new Error("conversation.list requires an authenticated user");
  }

  const conditions = [
    eq(schema.conversations.orgId, ctx.orgId),
    eq(schema.conversations.workspaceId, ctx.workspaceId),
    eq(schema.conversations.userId, ctx.userId),
    isNull(schema.conversations.deletedAt),
  ];

  if (input.filter === "active") {
    conditions.push(isNull(schema.conversations.archivedAt));
  } else {
    conditions.push(isNotNull(schema.conversations.archivedAt));
  }

  if (input.cursor) {
    conditions.push(lt(schema.conversations.updatedAt, new Date(input.cursor)));
  }

  const fetchLimit = input.limit + 1;

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.conversations.publicId,
        title: schema.conversations.title,
        status: schema.conversations.status,
        archivedAt: schema.conversations.archivedAt,
        createdAt: schema.conversations.createdAt,
        updatedAt: schema.conversations.updatedAt,
      })
      .from(schema.conversations)
      .where(and(...conditions))
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(fetchLimit),
  );

  let nextCursor: string | null = null;
  let conversations = rows;

  if (rows.length > input.limit) {
    nextCursor = rows[input.limit - 1]!.updatedAt.toISOString();
    conversations = rows.slice(0, input.limit);
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      filter: input.filter,
      count: conversations.length,
      hasNextPage: nextCursor !== null,
      surface: ctx.surface,
    },
    "conversation.list: returned conversations",
  );

  return {
    conversations: conversations.map((row) => ({
      publicId: row.publicId,
      title: row.title ?? null,
      status: row.status,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    nextCursor,
  };
};
