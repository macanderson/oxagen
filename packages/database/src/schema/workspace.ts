import { boolean, check, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceSchema } from "./_schemas";
import { auditMixin, citext, idMixin } from "./_mixins";
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

// Slug-history capture for workspace renames. Mirrors org_slug_history but
// scoped to (org_id, workspace_id) so the resolver can disambiguate workspace
// slugs across orgs (workspace slugs are only unique within a single org).
// Written in the SAME transaction as the workspace.slug UPDATE — capture is
// atomic with the rename (spec §4.5, §6.3). redirect_enabled=false freezes a
// row so the old URL 404s again.
export const workspaceSlugHistory = workspaceSchema.table(
  "workspace_slug_history",
  {
    ...idMixin("wsh"),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    oldSlug: citext("old_slug").notNull(),
    newSlug: citext("new_slug").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    redirectEnabled: boolean("redirect_enabled").notNull().default(true),
  },
  (t) => ({
    // Resolver hot path: (org_id, old_slug) — workspace slugs only unique per org.
    oldSlugIdx: index("workspace_slug_history_old_slug_idx").on(t.orgId, t.oldSlug),
    // Inverse lookup for admin tooling and per-workspace history listing.
    workspaceIdx: index("workspace_slug_history_workspace_idx").on(
      t.workspaceId,
      t.changedAt,
    ),
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
    // Workspace membership role is written in BOTH casings (lowercase by the
    // workspace create path, Capitalized via IAM role names). Case-insensitive
    // CHECK over the canonical role set rejects garbage without breaking either.
    roleCheck: check(
      "workspace_users_role_check",
      sql`lower(${t.role}) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer')`,
    ),
  }),
);
