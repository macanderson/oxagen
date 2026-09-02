import { z } from "zod";
import { registerCapability } from "../registry";

// Export formats supported by conversation.export.
export const conversationExportFormat = z.enum(["markdown", "pdf"]);

export const conversationExport = registerCapability({
  name: "export_conversation",
  domain: "conversation",
  description:
    "Export an entire conversation (active branch) as a Markdown document or a formatted PDF",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Exporting is a cheap read/serialize — it does not consume AI tokens, so the
  // billing gate must not block it (mirrors conversation.files.list).
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
    // The public_id of the conversation to export.
    conversationId: z.string(),
    // "markdown" returns the serialized document inline; "pdf" renders a
    // formatted PDF, persists it as a private generated asset, and returns
    // its access-controlled serve URL.
    format: conversationExportFormat,
  }),
  output: z.object({
    format: conversationExportFormat,
    // Suggested download filename, e.g. "quarterly-planning-2026-07-07.md".
    filename: z.string(),
    // Markdown source. Present for format "markdown", null for "pdf".
    content: z.string().nullable(),
    // Access-controlled serve URL (/api/v1/assets/:publicId) of the rendered
    // PDF. Present for format "pdf", null for "markdown".
    url: z.string().nullable(),
    // Number of messages on the exported (active) branch.
    messageCount: z.number().int(),
  }),
});

export type ConversationExportFormat = z.output<
  typeof conversationExportFormat
>;
export type ConversationExportInput = z.output<typeof conversationExport.input>;
export type ConversationExportOutput = z.output<
  typeof conversationExport.output
>;
