import { index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceSchema } from "./_schemas";
import { auditMixin, citext, idMixin, ltree, orgScopeMixin } from "./_mixins";
import { modelTierEnum } from "./auth";

export const workspaces = workspaceSchema.table(
  "workspaces",
  {
    ...idMixin("wrk"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    defaultGraphId: uuid("default_graph_id"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    // Workspace-level model defaults. NULL means the workspace sets no default
    // for that dimension and the user's own preference (or the system default)
    // applies. An explicit value overrides user preferences for all members.
    // Uses the same model_tier enum declared in the auth schema (shared type).
    defaultTextTier: modelTierEnum("default_text_tier"),
    defaultTextModel: text("default_text_model"),
    defaultImageModel: text("default_image_model"),
    defaultVideoModel: text("default_video_model"),
  },
  (t) => ({
    orgSlugIdx: uniqueIndex("workspaces_org_slug_idx").on(t.orgId, t.slug),
    orgIdx: index("workspaces_org_idx").on(t.orgId),
  }),
);

export const workspaceUsers = workspaceSchema.table(
  "workspace_users",
  {
    ...idMixin("wsu"),
    ...auditMixin(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    permissions: jsonb("permissions").notNull().default(sql`'{}'::jsonb`),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    workspaceUserIdx: uniqueIndex("workspace_users_workspace_user_idx").on(t.workspaceId, t.userId),
    userIdx: index("workspace_users_user_idx").on(t.userId),
  }),
);

export const folders = workspaceSchema.table(
  "folders",
  {
    ...idMixin("fld"),
    ...auditMixin(),
    ...orgScopeMixin(),
    parentFolderId: uuid("parent_folder_id"),
    name: text("name").notNull(),
    path: ltree("path").notNull(),
  },
  (t) => ({
    orgIdx: index("folders_org_idx").on(t.orgId, t.workspaceId),
    // GIST index on ltree path enables subtree containment queries
    // (path <@ ancestor) without sequential scans. Hand-written in the
    // initial migration since Drizzle has no first-class GIST helper.
    pathIdx: index("folders_path_idx").on(t.path),
  }),
);

