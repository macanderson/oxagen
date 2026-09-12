import { z } from "zod";
import { defineTool } from "./_define";
import { chatMessageSend } from "../chat.message.send";
// `post_conversation_message` is deliberately not imported: every one of its
// fields is a duplicate of `send_message`'s, so nothing carries by reference
// and an import would be a claim this file does not make. See `drops`.
import { conversationAttachmentAdd } from "../conversation.attachment.add";

/**
 * Appendix E: `ask_assistant` — "a turn of the in-app agent". Absorbs
 * `send_message`, `post_conversation_message` and `add_conversation_attachment`.
 *
 * **Name collision worth knowing about.** Appendix E also lists a *new*
 * `send_message` under Wrapping and control — the §7.6 tool that addresses
 * `@<agent-slug>`, `@agents` or a run id. It is a different tool with a
 * different job. Today's `send_message` (a chat turn) is absorbed here, which
 * is what frees the name.
 *
 * **`post_conversation_message` is the same ingress, spelled twice.** Its
 * `conversation_id` and `message` are `send_message`'s `conversationId` and
 * `content` in snake_case, without the 32 KiB content cap. §14.1 has one
 * assistant, driven by one contract across all four surfaces, so the duplicate
 * drops and the capped field carries. That cap is not cosmetic: an unbounded
 * `content` lets one authenticated request forward an arbitrarily large prompt
 * to the model, driving unbounded metering cost.
 *
 * **Attachments are ids, not bytes.** `add_conversation_attachment` is the
 * second half of the upload flow — the client stores bytes through
 * `asset.upload`, then names the result here. Only its asset id carries;
 * putting the bytes in a chat turn would make every turn a file upload.
 *
 * **A turn is a run.** §14.1: "Each of its turns is a run of its own, recorded
 * and metered like any other agent's run." So the output gains `runId`, which
 * no source had, and that id is what makes the turn openable on §14's Run page.
 */
export const askAssistant = defineTool({
  name: "ask_assistant",
  domain: "assistant",
  description:
    "Take one turn with the in-app agent: append the operator's message to a conversation, optionally with already-uploaded attachments, and stream the reply. The turn is recorded and metered as a run.",
  // Streaming. The output schema describes the terminal state persisted once
  // the stream completes; carried from `send_message`, which is the only one of
  // the three that is honest about this.
  mode: "async",
  /**
   * `add_conversation_attachment` also exposed "agent". Dropped: the in-app
   * agent calling `ask_assistant` is the assistant asking itself, and §14.1
   * already puts it on every screen as a panel. The stricter pair of surfaces
   * from the two chat contracts carries.
   */
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  /**
   * Deliberately unset. `add_conversation_attachment` declares
   * `noBillingGate: true` because linking a file record burns no model tokens.
   * A turn of the assistant burns plenty, so the looser value does not carry
   * and the admission gate applies — this is exactly the case the gate exists
   * for (carry rule 3: strictest wins).
   */

  absorbs: [
    "send_message",
    "post_conversation_message",
    "add_conversation_attachment",
  ],
  renames: [
    {
      from: "assetPublicId",
      source: "add_conversation_attachment",
      to: "attachments",
      why: "v1 attached one asset per call, so its field was a single `gen_…` id. A turn can name several, so the same element schema is carried by reference as the `attachments` array — the ownership and `status: \"ready\"` contract stays attached to the element, and the key names the list rather than the member.",
    },
  ],
  drops: [
    {
      field: "contentBlocks",
      from: "send_message",
      why: "`z.array(z.unknown())` — an untyped passthrough with no bound. Attachments are now named by asset id, and everything else a turn produces is a frame with a content-addressed body (§8.2), so there is nothing left for an unvalidated blob to carry.",
    },
    {
      field: "conversation_id",
      from: "post_conversation_message",
      why: "duplicate ingress — carried as `conversationId` from `send_message`, which also accepts null to open a new conversation",
    },
    {
      field: "message",
      from: "post_conversation_message",
      why: "duplicate of `content`, without the 32 KiB cap. The capped field carries; an uncapped chat ingress is an unbounded metering cost from a single authenticated request.",
    },
    {
      field: "output { message_id, created_at, author }",
      from: "post_conversation_message",
      why: "superseded by `send_message`'s output, which names both the user and assistant message ids and the active leaf — a branched conversation needs all three, and `author` is implied by which id it is",
    },
    {
      field: "output (the conversation-file record)",
      from: "add_conversation_attachment",
      why: "the attachment is already stored and already named by the caller's asset id; echoing its record back on every turn is a page of `list_conversations` (action `files`), not part of a reply",
    },
  ],

  // `send_message` grades medium, the other two low. Medium carries: a chat
  // turn carries operator prose to a model provider.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "conversation",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  // All three sources agree on this map.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Appends messages, opens a run, and streams a reply.
  mutates: true,

  input: z.object({
    /** Null opens a new conversation — carried nullable for exactly that. */
    conversationId: chatMessageSend.input.shape.conversationId,
    /**
     * Branching. Carried as a pair: `parentMessageId` says where the new branch
     * hangs and `branchReason` says why, and a branch with one and not the
     * other is a conversation tree nobody can explain later.
     */
    parentMessageId: chatMessageSend.input.shape.parentMessageId,
    branchReason: chatMessageSend.input.shape.branchReason,

    /** 1 to 32 KiB. See the drop on `message` for why the cap is load-bearing. */
    content: chatMessageSend.input.shape.content,

    /**
     * Public ids (`gen_…`) of assets already uploaded by the caller and in
     * `status: "ready"`. The element schema is carried from
     * `add_conversation_attachment` so its ownership and readiness contract
     * stays attached. Capped at 20: the cap is new, because v1 attached one
     * asset per call and so never needed one.
     */
    attachments: z
      .array(conversationAttachmentAdd.input.shape.assetPublicId)
      .max(20)
      .default([]),
  }),

  output: z.object({
    conversationId: chatMessageSend.output.shape.conversationId,
    userMessageId: chatMessageSend.output.shape.userMessageId,
    assistantMessageId: chatMessageSend.output.shape.assistantMessageId,
    /** Which leaf the next turn branches from after this one. */
    activeLeafMessageId: chatMessageSend.output.shape.activeLeafMessageId,

    /**
     * New (§14.1). The run this turn was recorded as — the same id `list_runs`
     * returns and `get_run` opens. Without it the assistant is the one agent in
     * the product whose work cannot be replayed or attributed, which is
     * precisely what §12.7 says must never be true of a model call.
     */
    runId: z.string().uuid(),
  }),
});

export type AskAssistantInput = z.output<typeof askAssistant.input>;
export type AskAssistantOutput = z.output<typeof askAssistant.output>;
