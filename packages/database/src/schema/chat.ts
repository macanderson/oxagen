import {
  check,
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { chatSchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin, softDeleteMixin } from "./_mixins";

export const conversations = chatSchema.table(
  "conversations",
  {
    ...idMixin("cnv"),
    ...auditMixin(),
    ...orgScopeMixin(),
    userId: uuid("user_id").notNull(),
    title: text("title"),
    status: text("status").notNull(),
    activeLeafMessageId: uuid("active_leaf_message_id"),
    // Archive is a reversible, user-facing soft state distinct from deletion:
    // archived conversations drop out of the active history list but stay
    // restorable. archived_at NULL = active. (conversation.archive toggles it.)
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    archivedByUserId: uuid("archived_by_user_id"),
    // Code binding: the repo + environment + agent selected on the FIRST
    // code-mode turn, claimed once (UPDATE … WHERE code_binding IS NULL) and
    // immutable for the conversation's lifetime — the coding target can never
    // drift mid-conversation. NULL = non-code conversation. Shape:
    // StoredCodeBinding (apps/app chat stream code-binding.ts).
    codeBinding: jsonb("code_binding"),
    // softDeleteMixin (deleted_at / deleted_by_user_id): the engineering law
    // forbids hard-deletes on org-scoped tables, so the user-facing "delete"
    // sets deleted_at — the row is retained for SOC2/audit but vanishes from
    // every list and is not restorable through the UI. conversation.delete and
    // conversation.purge both write here.
    ...softDeleteMixin(),
  },
  (t) => ({
    orgIdx: index("conversations_org_idx").on(t.orgId, t.workspaceId),
    userIdx: index("conversations_user_idx").on(t.userId),
    statusCheck: check(
      "conversations_status_check",
      sql`${t.status} IN ('active', 'archived', 'deleted')`,
    ),
    // The history nav lists a user's non-deleted conversations in a workspace
    // ordered by recency, split by archive state. This composite index serves
    // that scan without a sort: filter (workspaceId, userId, deletedAt,
    // archivedAt) then read updatedAt desc.
    listIdx: index("conversations_list_idx").on(
      t.workspaceId,
      t.userId,
      t.deletedAt,
      t.archivedAt,
      t.updatedAt,
    ),
  }),
);

export const messages = chatSchema.table(
  "messages",
  {
    ...idMixin("msg"),
    ...auditMixin(),
    ...orgScopeMixin(),
    conversationId: uuid("conversation_id").notNull(),
    parentMessageId: uuid("parent_message_id"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    contentBlocks: jsonb("content_blocks").notNull(),
    branchReason: text("branch_reason"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    // Spec §6.9: tree traversal needs (conversation_id, parent_message_id)
    // for fast walk-from-leaf-to-root reconstruction.
    conversationParentIdx: index("messages_conversation_parent_idx").on(
      t.conversationId,
      t.parentMessageId,
    ),
    // The chat history loader filters conversation_id (+ tenant) and ORDER BYs
    // created_at DESC (chat.stream route, conversation-page). The parent index
    // above serves the equality but forces an in-memory sort on created_at;
    // this composite serves the equality + sort in one scan.
    conversationCreatedIdx: index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    orgIdx: index("messages_org_idx").on(t.orgId, t.workspaceId),
  }),
);
