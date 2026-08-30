import { z } from "zod";
import { registerCapability } from "../registry";
import { conversationAssetItem } from "./conversation.files.list";

// Links an already-stored asset (e.g. the output of `asset.upload` with
// `source: "user_upload"`) to a conversation. This is the second half of the
// "attach a file to chat" flow: the client uploads bytes once via
// asset.upload, then calls this capability with the returned publicId to
// make the asset show up in conversation.files.list / the message thread.
//
// Read-adjacent, not generation — no AI tokens are consumed, so billing is
// bypassed exactly like conversation.files.list.
export const conversationAttachmentAdd = registerCapability({
  name: "add_conversation_attachment",
  domain: "conversation",
  description:
    "Link an already-uploaded asset to a conversation as a chat attachment and return its conversation-file record.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Linking a file record consumes no AI tokens — billing gate must not block this.
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "conversation",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Public id of the conversation to attach the asset to. */
    conversationId: z.string().min(1),
    /**
     * Public id (`gen_…`) of an already-uploaded/generated asset — typically
     * the `publicId` returned by `asset.upload` with `source: "user_upload"`.
     * Must belong to the caller and be in `status: "ready"`.
     */
    assetPublicId: z.string().min(1),
  }),
  output: conversationAssetItem,
});

export type ConversationAttachmentAddInput = z.output<
  typeof conversationAttachmentAdd.input
>;
export type ConversationAttachmentAddOutput = z.output<
  typeof conversationAttachmentAdd.output
>;
