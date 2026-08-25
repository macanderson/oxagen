import { bigint, check, index, jsonb, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contentSchema } from "./_schemas";
import {
  auditMixin,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
} from "./_mixins";

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
    // Provenance discriminator. 'generated' = produced by the in-app agent
    // (has a real `prompt` + `model`); 'user_upload' = a chat/agent attachment
    // the user supplied (no prompt — `prompt` defaults to ''). Reusing this
    // table keeps conversation.files.list, the serve route, and access policy
    // working for uploads without a second table.
    source: text("source").notNull().default("generated"),
    accessPolicy: text("access_policy").notNull().default("user"),
    status: text("status").notNull().default("ready"),
    // Blob reference. storageUrl/sizeBytes are null until an async render lands.
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key").notNull(),
    storageUrl: text("storage_url"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    // Generation provenance. `prompt` defaults to '' for user uploads (which
    // have no generation prompt); `model` is '' for uploads too.
    prompt: text("prompt").notNull().default(""),
    model: text("model").notNull(),
    // Optional linkage to the chat turn that produced the asset.
    conversationId: uuid("conversation_id"),
    messageId: uuid("message_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    orgIdx: index("generated_assets_org_idx").on(t.orgId, t.workspaceId),
    userIdx: index("generated_assets_user_idx").on(t.userId),
    conversationIdx: index("generated_assets_conversation_idx").on(
      t.conversationId,
    ),
    // conversation.files.list filters conversation_id (+ deleted_at IS NULL,
    // status='ready') and keyset-paginates on created_at DESC. The bare
    // conversation_idx above doesn't cover the created_at keyset/sort; this
    // composite serves the keyset scan directly.
    conversationCreatedIdx: index(
      "generated_assets_conversation_created_idx",
    ).on(t.conversationId, t.createdAt),
    // Assets list (unbounded, unindexed sort — 2026-07-11 audit §4.1 item 7).
    wsKindCreatedIdx: index("generated_assets_ws_kind_created_idx")
      .on(t.workspaceId, t.kind, t.status, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    kindCheck: check(
      "generated_assets_kind_check",
      sql`${t.kind} IN ('image', 'video', 'document', 'spreadsheet', 'presentation', 'pdf', 'archive')`,
    ),
    sourceCheck: check(
      "generated_assets_source_check",
      sql`${t.source} IN ('generated', 'user_upload')`,
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

// Editable text documents authored in the workspace (distinct from
// generated_assets, which references binary blobs). Body lives inline in
// `content`. Backs document.create / document.list / document.read.
export const documents = contentSchema.table(
  "documents",
  {
    ...idMixin("doc"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    orgIdx: index("documents_org_idx").on(t.orgId, t.workspaceId),
    // Documents list (unbounded, unindexed sort — also add .limit()! —
    // 2026-07-11 audit §4.1 item 7).
    workspaceCreatedIdx: index("documents_workspace_created_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);
