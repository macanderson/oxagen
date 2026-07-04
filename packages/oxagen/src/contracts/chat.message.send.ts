import { z } from "zod";
import { registerCapability } from "../registry";

// A user-supplied attachment ref (already uploaded via the browser multipart
// route, POST /api/v1/upload/attachment, or asset.upload with
// source: "user_upload") to thread onto the user turn's
// `messages.metadata.attachments`. Mirrors the client-side
// ConversationAttachmentRef shape (apps/app/src/components/chat/attachment-chip.tsx)
// — publicId refs only, never inline bytes, so a turn's persisted metadata
// stays tiny regardless of attachment size.
export const chatMessageSendAttachment = z.object({
  publicId: z.string().min(1),
  kind: z.enum(["image", "video", "document"]),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  /** Access-controlled serving URL (e.g. /api/v1/assets/gen_…). */
  url: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
});

// Streaming response is delivered via the AI SDK; the capability's output
// schema describes the *terminal* message persisted after the stream
// completes. The HTTP route emits an SSE / RSC stream that resolves to
// this shape.
export const chatMessageSend = registerCapability({
  name: "chat.message.send",
  domain: "chat",
  description: "Append a user message to a conversation and stream the assistant reply",
  mode: "async",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    conversationId: z.string().nullable(),
    parentMessageId: z.string().nullable(),
    branchReason: z.enum(["edit", "regenerate", "tool_retry", "manual_fork"]).nullable(),
    content: z.string().min(1),
    contentBlocks: z.array(z.unknown()).default([]),
    // Capped at 8 — mirrors the chat stream route's per-turn attachment cap.
    attachments: z.array(chatMessageSendAttachment).max(8).default([]),
  }),
  output: z.object({
    conversationId: z.string(),
    userMessageId: z.string(),
    assistantMessageId: z.string(),
    activeLeafMessageId: z.string(),
  }),
});

export type ChatMessageSendAttachment = z.output<typeof chatMessageSendAttachment>;
export type ChatMessageSendInput = z.output<typeof chatMessageSend.input>;
export type ChatMessageSendOutput = z.output<typeof chatMessageSend.output>;
