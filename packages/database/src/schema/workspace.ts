import { boolean, check, index, integer, jsonb, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

// ── workspace.workspace_memory_policy (OXA-1374) ─────────────────────────────
// One row per workspace. Stores the per-workspace memory decay policy:
//   halfLifeLowDays   — decay half-life in days for 'low' weight memories
//   halfLifeHighDays  — decay half-life in days for 'high' weight memories
//   recallThreshold   — memories below this confidence are excluded from recall
//
// Rows are created on first write; callers fall back to defaults when absent.
export const workspaceMemoryPolicy = workspaceSchema.table(
  "workspace_memory_policy",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4())`),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull().unique(),
    halfLifeLowDays: integer("half_life_low_days").notNull().default(30),
    halfLifeHighDays: integer("half_life_high_days").notNull().default(90),
    recallThreshold: real("recall_threshold").notNull().default(0.1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceIdx: uniqueIndex("workspace_memory_policy_workspace_idx").on(t.workspaceId),
    orgWorkspaceIdx: index("workspace_memory_policy_org_workspace_idx").on(t.orgId, t.workspaceId),
  }),
);
