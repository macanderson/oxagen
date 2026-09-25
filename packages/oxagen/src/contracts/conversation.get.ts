import { z } from "zod";
import { registerCapability } from "../registry";
import {
  assistantParkedCardSchema,
  assistantToolCallSchema,
} from "./assistant.ask";
import {
  conversationPublicIdSchema,
  conversationSummary,
} from "./conversation.list";

/** The most messages one read returns. */
export const CONVERSATION_MESSAGES_MAX = 200;

/**
 * One message on the conversation's thread. `runId` and `parkedCards` are
 * what an `ask_assistant` turn recorded on its reply: the run the turn was
 * recorded as, and the governed writes it parked for a person. `toolCalls` is
 * read from that run's ledger each time, never stored on the message, so it
 * lists what `ask_assistant` listed when the reply was new (#4161). A message
 * no turn wrote carries `null`, `[]` and `[]`.
 */
export const conversationMessage = z.object({
  publicId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string(),
  /** `arun_…`: the run an assistant turn was recorded as. */
  runId: z.string().nullable(),
  parkedCards: z.array(assistantParkedCardSchema),
  /**
   * The tool calls behind an assistant reply, in the order the run recorded
   * them. Empty on a user or system message, on a reply with no run, and on
   * every reply when the run ledger could not be read.
   */
  toolCalls: z.array(assistantToolCallSchema),
  /** True when the person stopped the turn and this is its partial reply (#4164). */
  stopped: z.boolean(),
});

/**
 * `get_conversation`: one of the caller's conversations with its messages,
 * read back so a surface can show the thread it left (#4163).
 *
 * The ownership rule is the one `list_conversations`, `rename_conversation`,
 * `archive_conversation` and `delete_conversation` apply: the conversation is
 * in this workspace, belongs to the person asking, and is not deleted. An
 * archived conversation of your own can be read by its id. A conversation
 * that fails the rule answers `not_found`, so a caller learns nothing about a
 * conversation that is not theirs. An API key reads as the person who created
 * it, the same person `ask_assistant` records the key's turns under.
 *
 * `conversationId: null` reads the caller's most recently updated active
 * conversation in the workspace, the thread the app's assistant flyout
 * reopens after a reload. It answers `conversation: null` when there is none.
 *
 * Messages follow the conversation's active branch, oldest first. A
 * conversation whose messages name no parent is linear, and reads in the
 * order it was written. The newest `limit` messages are returned, and
 * `truncated` says earlier ones were left out.
 */
export const conversationGet = registerCapability({
  name: "get_conversation",
  domain: "conversation",
  description:
    "Read one of your conversations in this workspace with its messages, oldest first, or your most recently updated active conversation when no id is given",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Reading a transcript does not consume AI tokens, and an organization at
  // zero credit balance must still see its own history (INV-28).
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "conversation",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** The `cnv_` public id. Null reads the latest active conversation. */
    conversationId: conversationPublicIdSchema.nullable().default(null),
    /** The newest messages to return, 1 to 200. */
    limit: z.number().int().min(1).max(CONVERSATION_MESSAGES_MAX).default(100),
  }),
  output: z.object({
    /** Null when no id was given and the caller has no active conversation. */
    conversation: conversationSummary
      .extend({
        messages: z.array(conversationMessage),
        /** True when `limit` left earlier messages on the thread out. */
        truncated: z.boolean(),
      })
      .nullable(),
  }),
});

export type ConversationMessage = z.output<typeof conversationMessage>;
export type ConversationGetInput = z.output<typeof conversationGet.input>;
export type ConversationGetOutput = z.output<typeof conversationGet.output>;
