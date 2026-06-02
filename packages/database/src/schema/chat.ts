import { boolean, index, jsonb, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { chatSchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin } from "./_mixins";

export const conversations = chatSchema.table(
  "conversations",
  {
    ...idMixin("cnv"),
    ...auditMixin(),
    ...orgScopeMixin(),
    userId: uuid("user_id").notNull(),
    agentVersionId: uuid("agent_version_id"),
    title: text("title"),
    status: text("status").notNull(),
    activeLeafMessageId: uuid("active_leaf_message_id"),
  },
  (t) => ({
    orgIdx: index("conversations_org_idx").on(t.orgId, t.workspaceId),
    userIdx: index("conversations_user_idx").on(t.userId),
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
    isActiveInBranch: boolean("is_active_in_branch").notNull().default(true),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    // Spec §6.9: tree traversal needs (conversation_id, parent_message_id)
    // for fast walk-from-leaf-to-root reconstruction.
    conversationParentIdx: index("messages_conversation_parent_idx").on(t.conversationId, t.parentMessageId),
    orgIdx: index("messages_org_idx").on(t.orgId, t.workspaceId),
  }),
);
