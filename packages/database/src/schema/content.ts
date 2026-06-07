import { bigint, check, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contentSchema } from "./_schemas";
import { auditMixin, idMixin, orgScopeMixin, softDeleteMixin } from "./_mixins";

export const files = contentSchema.table(
  "files",
  {
    ...idMixin("fil"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    storageProvider: text("storage_provider").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    storageIdx: uniqueIndex("files_storage_idx").on(t.storageProvider, t.storageBucket, t.storageKey),
    orgIdx: index("files_org_idx").on(t.orgId, t.workspaceId),
    checksumIdx: index("files_checksum_idx").on(t.orgId, t.checksumSha256),
  }),
);

// AI-generated media assets (image / video) produced from the in-app agent.
// The blob bytes live in file storage (Vercel Blob behind @oxagen/storage); this
// row is the reference + provenance + access policy, per the four-store model.
//
// Access model (forward-compatible, enforced by serveGeneratedAsset):
//   user   — visible only to the generating user (the private default)
//   org    — visible to any member of the owning org (today's chat behavior;
//            the chat create-path sets this explicitly so teammates viewing the
//            shared conversation can see the asset)
//   public — visible to anyone with the link
// The column DEFAULTS to `user` (private); the create-path opts assets up to the
// policy the surface wants. `status` is `ready` for synchronous image
// generation and walks pending→ready/failed for async video renders.
export const generatedAssets = contentSchema.table(
  "generated_assets",
  {
    ...idMixin("gen"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    // The user who generated the asset (ownership; drives the `user` access
    // policy). Distinct from auditMixin.createdByUserId (nullable audit field).
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull(),
    accessPolicy: text("access_policy").notNull().default("user"),
    status: text("status").notNull().default("ready"),
    // Blob reference. storageUrl/sizeBytes are null until an async render lands.
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key").notNull(),
    storageUrl: text("storage_url"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    // Generation provenance.
    prompt: text("prompt").notNull(),
    model: text("model").notNull(),
    // Optional linkage to the chat turn that produced the asset.
    conversationId: uuid("conversation_id"),
    messageId: uuid("message_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    orgIdx: index("generated_assets_org_idx").on(t.orgId, t.workspaceId),
    userIdx: index("generated_assets_user_idx").on(t.userId),
    conversationIdx: index("generated_assets_conversation_idx").on(t.conversationId),
    kindCheck: check(
      "generated_assets_kind_check",
      sql`${t.kind} IN ('image', 'video', 'document', 'spreadsheet', 'presentation', 'pdf', 'archive')`,
    ),
    accessPolicyCheck: check(
      "generated_assets_access_policy_check",
      sql`${t.accessPolicy} IN ('user', 'org', 'public')`,
    ),
    statusCheck: check(
      "generated_assets_status_check",
      sql`${t.status} IN ('pending', 'ready', 'failed')`,
    ),
  }),
);

export const documents = contentSchema.table(
  "documents",
  {
    ...idMixin("doc"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    fileId: uuid("file_id").notNull(),
    folderId: uuid("folder_id"),
    title: text("title").notNull(),
    documentType: text("document_type").notNull(),
    embeddingStatus: text("embedding_status").notNull(),
  },
  (t) => ({
    orgIdx: index("documents_org_idx").on(t.orgId, t.workspaceId),
    fileIdx: index("documents_file_idx").on(t.fileId),
    folderIdx: index("documents_folder_idx").on(t.folderId),
    embeddingStatusIdx: index("documents_embedding_status_idx").on(t.embeddingStatus),
  }),
);

