import { z } from "zod";
import { registerCapability } from "../registry";

// Canonical asset kinds produced by the in-app agent.
// Mirrors the generated_assets_kind_check constraint in content.ts.
export const conversationAssetKind = z.enum([
  "image",
  "video",
  "document",
  "spreadsheet",
  "presentation",
  "pdf",
  "archive",
]);

// Canonical access policies mirroring generated_assets_access_policy_check.
export const conversationAssetAccessPolicy = z.enum(["user", "org", "public"]);

// A single generated asset visible to the requesting user in a conversation.
// This is the canonical exported type — replaces the bespoke ConversationAssetItem
// declared in the apps/app Next.js route handler.
export const conversationAssetItem = z.object({
  publicId: z.string(),
  kind: conversationAssetKind,
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().nullable(),
  status: z.string(),
  accessPolicy: conversationAssetAccessPolicy,
  createdAt: z.string(),
  /** Access-controlled serving URL (e.g. /api/v1/assets/:publicId). */
  url: z.string(),
});

export const conversationFilesList = registerCapability({
  name: "list_conversation_files",
  domain: "conversation",
  description:
    "List the ready generated assets attached to a conversation, access-policy filtered, newest-first, keyset-paginated",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // File listing does not consume AI tokens — billing gate must not block this.
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
    // The public_id of the conversation whose assets to list.
    conversationId: z.string(),
    // Optional kind filter. When omitted all supported kinds are included.
    kind: conversationAssetKind.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    // Keyset cursor: ISO createdAt of the last row from the previous page.
    // Null / omitted starts at the newest asset.
    cursor: z.string().nullable().default(null),
  }),
  output: z.object({
    files: z.array(conversationAssetItem),
    // Null when this is the last page (fewer than `limit` rows returned).
    nextCursor: z.string().nullable(),
  }),
});

export type ConversationAssetKind = z.output<typeof conversationAssetKind>;
export type ConversationAssetAccessPolicy = z.output<
  typeof conversationAssetAccessPolicy
>;
export type ConversationAssetItem = z.output<typeof conversationAssetItem>;
export type ConversationFilesListInput = z.output<
  typeof conversationFilesList.input
>;
export type ConversationFilesListOutput = z.output<
  typeof conversationFilesList.output
>;
