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
    // Immutable handle, unique WITHIN the org (like slug). SEPARATE from slug on
    // purpose: slugs are renameable (workspace_slug_history), namespaces never
    // change once set (enforced by the workspaces_namespace_immutable trigger).
    // It is the middle segment of the agentKey org_ns.workspace_ns.agent_slug,
    // whose 32-char budget is 6 (org) + 1 + 6 (workspace) + 1 + 18 (agent slug).
    // Derived from the slug at creation via deriveNamespace() over the org's
    // existing workspace namespaces.
    namespace: citext("namespace").notNull(),
    // Nullable avatar. Either an https:// URL or the platform designed-avatar
    // spec string "avatar:v1:<json>" ({emoji,bg,mode}); capped at 512 chars at
    // the contract layer. Same column name as users/organizations for
    // consistency, even though it may carry the spec string, not a plain URL.
    avatarUrl: text("avatar_url"),
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
    // Namespace unique per org + immutable. Immutability is enforced by a
    // BEFORE UPDATE trigger (migration 20260709120000_namespace_identity), not
    // expressible in Drizzle DDL.
    orgNamespaceIdx: uniqueIndex("workspaces_org_namespace_idx").on(t.orgId, t.namespace),
    namespaceCheck: check(
      "workspaces_namespace_check",
      sql`${t.namespace} ~ '^[a-z0-9]{2,6}$'`,
    ),
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
    // DEPRECATED — dead column. Superseded by the IAM store
    // (`iam.role_grants` / `iam.principal_role_assignments`), which is the sole
    // source of truth for effective permissions. No app/handler/auth code reads
    // or writes this; it retains its `{}` insert default only. Do NOT wire new
    // authorization logic to it — grant via IAM instead.
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

// ── workspace.workspace_memory_policy (OXA-1374, two-axis model) ────────────
// One row per workspace. Stores the per-workspace memory decay + enforcement
// policy:
//   halfLifeLowDays      — decay half-life (days) for OBSERVATION memories
//   halfLifeHighDays     — decay half-life (days) for RULE memories
//   recallThreshold      — memories below this confidence fraction (0-1) are
//                          excluded from recall
//   complianceThreshold  — enforcement (1-100) at/above which a RULE
//                          deviation is a VIOLATION rather than DISCRETION
//   defaultDecayFloor    — confidence (0-100) new memories never auto-decay
//                          below
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
    complianceThreshold: integer("compliance_threshold").notNull().default(70),
    defaultDecayFloor: real("default_decay_floor").notNull().default(5),
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

// Per-workspace per-turn dollar budget GOVERNANCE. An org/workspace admin sets a
// budget an org admin can dictate for a workspace: a soft `default` (seeds
// members who haven't set their own) or a hard `ceiling` (clamps members — they
// can't exceed it and the enforcement mode can only get stricter). Resolved
// against the member's own budget by resolveEffectiveTurnBudget in @oxagen/billing;
// the shared runCodingAgent guard enforces the single merged policy. Rows created
// on first write; absent ⇒ no governance (members keep their personal budget).
// (Org-WIDE default across all workspaces is a planned follow-up — the merge
// function already accepts an org level, so it needs no billing change.)
export const workspaceBudgetPolicy = workspaceSchema.table(
  "workspace_budget_policy",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4())`),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull().unique(),
    // Whether the governed budget is active for this workspace.
    enabled: boolean("enabled").notNull().default(true),
    // Governed ceiling/default in USD; NULL when no amount is set yet.
    limitUsd: real("limit_usd"),
    // Enforcement mode at the ceiling: "grace" | "prompt" | "enforce".
    mode: text("mode").notNull().default("enforce"),
    // grace mode: fraction ABOVE the limit allowed before a hard stop (0.25 = 25%).
    graceOveragePct: real("grace_overage_pct").notNull().default(0.25),
    // "ceiling" = hard cap members can't exceed; "default" = seed members can override.
    enforcement: text("enforcement").notNull().default("ceiling"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceIdx: uniqueIndex("workspace_budget_policy_workspace_idx").on(t.workspaceId),
    orgWorkspaceIdx: index("workspace_budget_policy_org_workspace_idx").on(t.orgId, t.workspaceId),
  }),
);
