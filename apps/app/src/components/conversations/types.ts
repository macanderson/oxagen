/**
 * Shared types for the workspace conversation-history nav. The bound-action
 * shapes are what conversation-page.tsx passes after `.bind(null, ctx)` — the
 * client components never see org/workspace ids, only these pre-scoped calls.
 */
import type { ConversationSummary } from "@oxagen/oxagen/contracts/conversation.list";
import type {
  ListConversationsResult,
  MutationResult,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/conversation-actions";

export type { ConversationSummary, ListConversationsResult, MutationResult };

export type ListConversations = (args: {
  filter: "active" | "archived";
  cursor?: string | null;
}) => Promise<ListConversationsResult>;

export type RenameConversation = (
  conversationId: string,
  title: string,
) => Promise<MutationResult>;

export type ArchiveConversations = (
  conversationIds: string[],
  archived: boolean,
) => Promise<MutationResult>;

export type DeleteConversations = (
  conversationIds: string[],
) => Promise<MutationResult>;

export type PurgeArchived = () => Promise<MutationResult>;

export interface ConversationNavActions {
  list: ListConversations;
  rename: RenameConversation;
  archive: ArchiveConversations;
  delete: DeleteConversations;
  purge: PurgeArchived;
}
