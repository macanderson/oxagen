import { schema } from "@oxagen/database";
import { sql, type SQL } from "drizzle-orm";
import {
  MAX_EXPORT_HEADER_BYTES,
  MAX_EXPORT_MESSAGES,
  MAX_EXPORT_SOURCE_BYTES,
} from "./conversation-export-limits";
import type { ExportMessageRow } from "./conversation-markdown";

export type ConversationExportSnapshot = {
  title: string | null;
  createdAt: string;
  activeLeafMessageId: string | null;
  messageCount: number;
  sourceTooLarge: boolean;
  titleTooLarge: boolean;
  messages: (Omit<ExportMessageRow, "createdAt"> & { createdAt: string })[] | null;
};

/** One statement pins the active leaf, byte budget, and payload to one snapshot. */
export function conversationExportSnapshotQuery(
  conversationId: string,
  orgId: string,
  workspaceId: string,
): SQL {
  const conversations = schema.conversations;
  const messages = schema.messages;
  return sql`
    with target as materialized (
      select ${conversations.id} as id, ${conversations.title} as title,
        ${conversations.createdAt} as created_at,
        ${conversations.activeLeafMessageId} as active_leaf_message_id
      from ${conversations}
      where ${conversations.publicId} = ${conversationId}
        and ${conversations.orgId} = ${orgId}
        and ${conversations.workspaceId} = ${workspaceId}
        and ${conversations.deletedAt} is null
      limit 1
    ), candidates as materialized (
      select ${messages.id} as id, ${messages.parentMessageId} as parent_message_id,
        ${messages.role} as role, ${messages.content} as content,
        ${messages.contentBlocks} as content_blocks, ${messages.metadata} as metadata,
        ${messages.createdAt} as created_at
      from ${messages}
      where ${messages.conversationId} in (select id from target)
        and ${messages.orgId} = ${orgId}
        and ${messages.workspaceId} = ${workspaceId}
      order by ${messages.createdAt}, ${messages.id}
      limit ${MAX_EXPORT_MESSAGES + 1}
    ), budget as materialized (
      select count(*)::integer as message_count,
        coalesce(sum(octet_length(content)::bigint + octet_length(role)::bigint
          + octet_length(content_blocks::text)::bigint
          + octet_length(metadata::text)::bigint), 0) > ${MAX_EXPORT_SOURCE_BYTES} as too_large
      from candidates
    )
    select
      case when coalesce(octet_length(target.title), 0) <= ${MAX_EXPORT_HEADER_BYTES}
        then target.title else null end as title,
      target.created_at::text as "createdAt",
      target.active_leaf_message_id as "activeLeafMessageId",
      budget.message_count as "messageCount",
      budget.too_large as "sourceTooLarge",
      coalesce(octet_length(target.title), 0) > ${MAX_EXPORT_HEADER_BYTES} as "titleTooLarge",
      case when budget.message_count <= ${MAX_EXPORT_MESSAGES} and not budget.too_large
        and coalesce(octet_length(target.title), 0) <= ${MAX_EXPORT_HEADER_BYTES}
      then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', id, 'parentMessageId', parent_message_id, 'role', role,
          'content', content, 'contentBlocks', content_blocks, 'metadata', metadata,
          'createdAt', created_at
        ) order by created_at, id), '[]'::jsonb) from candidates
      ) else null end as messages
    from target cross join budget
  `;
}
