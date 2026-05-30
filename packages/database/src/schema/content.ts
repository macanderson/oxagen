import { bigint, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contentSchema } from "./_schemas.js";
import { auditMixin, idMixin, orgScopeMixin } from "./_mixins.js";

export const files = contentSchema.table(
  "files",
  {
    ...idMixin("fil"),
    ...auditMixin(),
    ...orgScopeMixin(),
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

export const documents = contentSchema.table(
  "documents",
  {
    ...idMixin("doc"),
    ...auditMixin(),
    ...orgScopeMixin(),
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

export const contentGenerations = contentSchema.table(
  "content_generations",
  {
    ...idMixin("cgn"),
    ...auditMixin(),
    ...orgScopeMixin(),
    executionStepId: uuid("execution_step_id").notNull(),
    generationType: text("generation_type").notNull(),
    sourceDocumentIds: uuid("source_document_ids").array(),
    outputDocumentId: uuid("output_document_id"),
    recipeConfig: jsonb("recipe_config").notNull(),
  },
  (t) => ({
    orgIdx: index("content_generations_org_idx").on(t.orgId, t.workspaceId),
    stepIdx: index("content_generations_step_idx").on(t.executionStepId),
  }),
);
