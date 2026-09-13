import { z } from "zod";
import { defineTool } from "./_define";
import { conversationList } from "../conversation.list";
import { conversationRename } from "../conversation.rename";
import { conversationArchive } from "../conversation.archive";
import { conversationDelete } from "../conversation.delete";
import { conversationExport } from "../conversation.export";
import { conversationPurge } from "../conversation.purge";
import { conversationFilesList } from "../conversation.files.list";

/**
 * Appendix E: `list_conversations` — "with the actions as arguments". Absorbs
 * `list_conversations`, `rename_conversation`, `archive_conversation`,
 * `delete_conversation`, `export_conversation`, `purge_conversations` and
 * `list_conversation_files`.
 *
 * Seven contracts, one tool, nothing dropped: every field of every source is
 * carried by reference onto the arm that owns it, so `drops` is `[]`. The
 * interesting work here is not the schema — it is what folding a destructive
 * action into a read does to the tool's grades.
 *
 * **Why a discriminated union on both sides.** "The actions as arguments" could
 * be one flat object with mostly-optional fields, but then "rename with no
 * title" and "delete with no ids" become handler errors instead of parse
 * errors, and the output becomes a bag of nullable keys where a caller has to
 * guess which one is populated. Discriminating on `action` makes each arm
 * exactly the v1 contract it came from, and echoing `action` in the output
 * makes the response discriminable too.
 *
 * **The name understates the tool, and Appendix E chose that.** Under ADR-025 a
 * verb-first name should say the strongest thing a tool does, and the strongest
 * thing here is `purge`. The appendix nonetheless names it `list_conversations`
 * because listing is the common case and the destructive arms are the action
 * menu on a list row. The grades below are what stop the name from being a lie:
 * they are set by `purge`, not by `list`.
 *
 * **The cost of the fold, stated plainly.** `sensitivity: "destructive"` and
 * `requiresApproval: true` now apply to reading a conversation list, because a
 * contract carries one static grade and it has to be the ceiling of its arms.
 * The per-action distinction belongs in policy: §6.9 keys approval rules on the
 * canonical action, which includes the argument path, so a workspace can
 * auto-approve `action: "list"` and hold `action: "purge"` for a human. That
 * rule has to exist before this tool is usable on a UI, and it is the one thing
 * a reviewer should check.
 */
export const listConversations = defineTool({
  name: "list_conversations",
  domain: "assistant",
  description:
    "List a user's conversations, or act on them: list their files, rename one, archive or restore, delete, export as Markdown or PDF, or purge every archived conversation.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  /**
   * Carried `true`, against a naive reading of the strictest-value rule.
   * `list_conversations`, `list_conversation_files` and `export_conversation`
   * each set this deliberately and each say why: none of them consume AI
   * tokens, and an org at zero credit balance must still be able to read and
   * export its own history. The other four never set it — that is silence, not
   * a decision, and none of them touches a model either. Rule 3 reconciles
   * *decisions*; it does not promote an unstated default over a stated reason.
   */
  noBillingGate: true,

  absorbs: [
    "list_conversations",
    "rename_conversation",
    "archive_conversation",
    "delete_conversation",
    "export_conversation",
    "purge_conversations",
    "list_conversation_files",
  ],
  drops: [],

  /**
   * From `delete_conversation` and `purge_conversations`, which are the
   * strictest of the seven. Both are irreversible from the user's perspective
   * — the engineering law forbids hard deletes, so they set `deleted_at` and
   * the row is retained for audit but is not restorable through any product
   * surface. See the note above about pushing the distinction into policy.
   */
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "conversation",
  },
  sensitivity: "destructive",
  defaultEffect: "deny",
  // All seven sources agree on this map.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Five of the seven arms write. `false` would be wrong for all of them.
  mutates: true,

  input: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("list"),
      /**
       * `active` is `archived_at IS NULL`, `archived` is not null. Soft-deleted
       * rows are returned by neither — carried by reference so that rule stays
       * attached to the field that encodes it.
       */
      filter: conversationList.input.shape.filter,
      limit: conversationList.input.shape.limit,
      /** Keyset cursor: ISO `updated_at` of the last row of the previous page. */
      cursor: conversationList.input.shape.cursor,
    }),

    z.object({
      action: z.literal("files"),
      conversationId: conversationFilesList.input.shape.conversationId,
      /** Omitted includes every supported asset kind. */
      kind: conversationFilesList.input.shape.kind,
      limit: conversationFilesList.input.shape.limit,
      cursor: conversationFilesList.input.shape.cursor,
    }),

    z.object({
      action: z.literal("rename"),
      /** The `cnv_` public id — the same identifier the URL and the nav carry. */
      conversationId: conversationRename.input.shape.conversationId,
      /** Trimmed, 1–200 chars: a title is a nav row, not a document. */
      title: conversationRename.input.shape.title,
    }),

    z.object({
      action: z.literal("archive"),
      /** Set-based, up to 100 ids — no per-item round trip. */
      conversationIds: conversationArchive.input.shape.conversationIds,
      /** true archives (sets `archived_at`), false restores. Reversible either way. */
      archived: conversationArchive.input.shape.archived,
    }),

    z.object({
      action: z.literal("delete"),
      conversationIds: conversationDelete.input.shape.conversationIds,
    }),

    z.object({
      action: z.literal("export"),
      conversationId: conversationExport.input.shape.conversationId,
      /** `markdown` returns the document inline; `pdf` persists a private asset. */
      format: conversationExport.input.shape.format,
    }),

    /**
     * No arguments by design: the set is "all of my archived conversations in
     * this workspace", resolved server-side in one set-based update. An id list
     * here would be a different, weaker guarantee.
     */
    z.object({ action: z.literal("purge") }),
  ]),

  /**
   * Discriminated on the same literal as the input, so a caller narrows the
   * response by the action it asked for rather than by probing for a non-null
   * key.
   */
  output: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("list"),
      conversations: conversationList.output.shape.conversations,
      /** Null on the last page. */
      nextCursor: conversationList.output.shape.nextCursor,
    }),
    z.object({
      action: z.literal("files"),
      files: conversationFilesList.output.shape.files,
      nextCursor: conversationFilesList.output.shape.nextCursor,
    }),
    z.object({
      action: z.literal("rename"),
      publicId: conversationRename.output.shape.publicId,
      title: conversationRename.output.shape.title,
    }),
    z.object({
      action: z.literal("archive"),
      updated: conversationArchive.output.shape.updated,
    }),
    z.object({
      action: z.literal("delete"),
      deleted: conversationDelete.output.shape.deleted,
    }),
    z.object({
      action: z.literal("export"),
      format: conversationExport.output.shape.format,
      filename: conversationExport.output.shape.filename,
      /** Markdown source, or null for `pdf`. */
      content: conversationExport.output.shape.content,
      /** Access-controlled serve URL of the rendered PDF, or null for `markdown`. */
      url: conversationExport.output.shape.url,
      messageCount: conversationExport.output.shape.messageCount,
    }),
    z.object({
      action: z.literal("purge"),
      deleted: conversationPurge.output.shape.deleted,
    }),
  ]),
});

export type ListConversationsInput = z.output<typeof listConversations.input>;
export type ListConversationsOutput = z.output<typeof listConversations.output>;
