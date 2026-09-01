import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    // Human-readable blurb. Promoted out of the settings JSONB bag (2026-07-11
    // audit §1.7) so workspace.settings.write and prompt.settings.write update
    // disjoint columns and can no longer clobber each other's key.
    description: text("description"),
    // Workspace prompt customization ({additionalInstructions, overrides,
    // autoImprovePrompts}). Own column for the same reason; prompt.settings.write
    // merges it atomically via jsonb `||`.
    promptConfig: jsonb("prompt_config").notNull().default(sql`'{}'::jsonb`),
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
    orgNamespaceIdx: uniqueIndex("workspaces_org_namespace_idx").on(
      t.orgId,
      t.namespace,
    ),
    namespaceCheck: check(
      "workspaces_namespace_check",
      sql`${t.namespace} ~ '^[a-z0-9]{2,6}$'`,
    ),
    // workspaces_org_idx was dropped (2026-07-11 audit §4.2): a strict prefix
    // of the unique (org_id, slug) index above, so it served no query the
    // wider index didn't already cover.
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
    oldSlugIdx: index("workspace_slug_history_old_slug_idx").on(
      t.orgId,
      t.oldSlug,
    ),
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
    joinedAt: timestamp("joined_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    workspaceUserIdx: uniqueIndex("workspace_users_workspace_user_idx").on(
      t.workspaceId,
      t.userId,
    ),
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

// ── workspace.workspace_memory_policy (two-axis model) ──────────────────────
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
    // workspace_memory_policy_workspace_idx was dropped (2026-07-11 audit
    // §4.2, migration 20260802150000_index_constraint_hardening): duplicate of
    // the workspaceId.unique() constraint above (identical single column,
    // both unique). Not redeclared here — see workspaces_org_idx above for
    // the same documented-removal pattern.
    orgWorkspaceIdx: index("workspace_memory_policy_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);

// Per-workspace per-turn dollar budget GOVERNANCE. An org/workspace admin sets a
// budget an org admin can dictate for a workspace: a soft `default` (seeds
// members who haven't set their own) or a hard `ceiling` (clamps members — they
// can't exceed it and the enforcement mode can only get stricter). Resolved
// against the member's own budget by resolveEffectiveTurnBudget in @oxagen/billing;
// the per-turn budget guard applies the single merged policy. Rows created
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
    // numeric(12,2), not real/float4 (2026-07-11 audit §5 item 1): this value
    // feeds direct comparisons/arithmetic in packages/billing/src/turn-budget.ts
    // and float rounding error is not acceptable for a dollar ceiling.
    limitUsd: numeric("limit_usd", { precision: 12, scale: 2, mode: "number" }),
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
    // workspace_budget_policy_workspace_idx was dropped (2026-07-11 audit
    // §4.2, migration 20260802150000_index_constraint_hardening): duplicate of
    // the workspaceId.unique() constraint above (identical single column,
    // both unique). Not redeclared here — see workspaces_org_idx above for
    // the same documented-removal pattern.
    orgWorkspaceIdx: index("workspace_budget_policy_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);

// Verified-Outcome Market Router GOVERNANCE. An org/workspace admin decides
// whether model routing is learned+economic (market) or the deterministic
// default, and the tunables (verified-success bar, min samples, window,
// tier-escalation on judge rejection). ONE table holds both scopes: a row with
// workspace_id = NULL is the org-level default for every workspace; a row with a
// workspace_id overrides it for that workspace. Resolved by
// resolveEffectiveRoutingPolicy in @oxagen/agent-engine (workspace > org >
// OFF-default). Off by default — absent rows ⇒ today's deterministic routing.
// RLS: `workspace_nullable` (org_id NOT NULL, workspace_id nullable), so a
// withTenantDb read sees both the org-default row and the workspace's own row.
export const routingPolicy = workspaceSchema.table(
  "routing_policy",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4())`),
    orgId: uuid("org_id").notNull(),
    // NULL ⇒ this is the ORG-LEVEL default policy for all workspaces in the org.
    // A non-NULL value scopes the policy to that one workspace.
    workspaceId: uuid("workspace_id"),
    // Router mode: "off" (deterministic — today), "shadow" (compute + record the
    // market decision, keep today's routing), "enforce" (use the market decision).
    mode: text("mode").notNull().default("off"),
    // Minimum observed verified-success rate (0..1) a model must hit to serve.
    successThreshold: real("success_threshold").notNull().default(0.95),
    // Minimum observed samples before a model's verified rate is trusted.
    minSamples: integer("min_samples").notNull().default(20),
    // Trailing window (days) the routing stats are computed over.
    windowDays: integer("window_days").notNull().default(30),
    // Escalate the worker one tier when the completeness judge rejects a round.
    escalateOnRejection: boolean("escalate_on_rejection")
      .notNull()
      .default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // At most one org-level default row per org (workspace_id IS NULL)…
    orgDefaultIdx: uniqueIndex("routing_policy_org_default_idx")
      .on(t.orgId)
      .where(sql`workspace_id IS NULL`),
    // …and at most one row per workspace.
    workspaceIdx: uniqueIndex("routing_policy_workspace_idx")
      .on(t.workspaceId)
      .where(sql`workspace_id IS NOT NULL`),
    orgWorkspaceIdx: index("routing_policy_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
  }),
);
