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
import { COST_CENTER_LABEL_PATTERN } from "./cost";
import { workspaceSchema } from "./_schemas";
import { auditMixin, citext, idMixin, uuidv7Default } from "./_mixins";
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
    // Consequence tag → the IAM org role names that may grant, change or
    // revoke a mandate for that consequence (ADR-059 decision 1). Overrides
    // only: a tag with no entry takes DEFAULT_CONSEQUENCE_ROLES from
    // @oxagen/oxagen/mandates/schemas. Written by update_workspace_settings.
    consequenceRoles: jsonb("consequence_roles")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Workspace-level text model defaults. NULL means the workspace sets no
    // default and the user's own preference (or the system default) applies. An
    // explicit value overrides user preferences for all members. Image/video
    // defaults were dropped with media generation (ADR-043).
    // Uses the same model_tier enum declared in the auth schema (shared type).
    defaultTextTier: modelTierEnum("default_text_tier"),
    defaultTextModel: text("default_text_model"),
    // Archived by `archive_workspace` (issue #2964). NULL = active. An
    // archived workspace leaves `list_workspaces` (the switcher and the CLI
    // picker) unless the caller asks for it; its rows stay readable and its
    // slug stays taken. Both columns move together (CHECK below).
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    archivedByUserId: uuid("archived_by_user_id"),
    // The cost center this workspace's spend is charged back to when the run's
    // agent names none: a label from `cost.cost_centers`, checked by the write
    // handler (no cross-schema FK).
    costCenter: text("cost_center"),
  },
  (t) => ({
    orgSlugIdx: uniqueIndex("workspaces_org_slug_idx").on(t.orgId, t.slug),
    archivedCheck: check(
      "workspaces_archived_check",
      sql`(${t.archivedAt} IS NULL) = (${t.archivedByUserId} IS NULL)`,
    ),
    costCenterCheck: check(
      "workspaces_cost_center_check",
      sql`${t.costCenter} IS NULL OR ${t.costCenter} ~ '${sql.raw(COST_CENTER_LABEL_PATTERN)}'`,
    ),
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
    id: uuid("id").primaryKey().default(uuidv7Default),
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
    id: uuid("id").primaryKey().default(uuidv7Default),
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

// Per-workspace policy for the sessions Oxagen does not run — a wrapped
// Claude Code or Codex behind the loopback model proxy (ADR-094). This is the
// setting `unsignedBundle` signs into the policy bundle's `budget` and
// `models` clauses, and it is a different thing from workspaceBudgetPolicy
// above: that one governs an in-app assistant TURN, this one governs a wrapped
// harness SESSION on somebody's laptop. Absent row ⇒ observed-only, which is
// what every host had before this table (the bundle carried a hardcoded
// `budget.mode: "observed"`, so the proxy's refusal branches were unreachable
// — docs/audits/2026-09-21-model-gateway-arming.md).
export const tachoSessionPolicy = workspaceSchema.table(
  "tacho_session_policy",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id").notNull().unique(),
    // "observed" = meter only; "enforced" = the proxy refuses on the clauses.
    mode: text("mode").notNull().default("observed"),
    // Per-session ceiling in USD; NULL = no ceiling. numeric, not real: it
    // feeds a direct comparison against observed spend and float rounding
    // error is not acceptable for a dollar ceiling (2026-07-11 audit §5).
    sessionLimitUsd: numeric("session_limit_usd", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    // NULL = no allowlist stated, so every model is permitted; [] = an
    // allowlist that permits nothing. The two are different decisions and do
    // not share an encoding, the same reading `gateway_tools` carries on the
    // wire. An entry ending in `*` matches by prefix.
    modelAllow: jsonb("model_allow").$type<string[] | null>(),
    // Refused whatever the allowlist says; a deny beats an allow.
    modelDeny: jsonb("model_deny")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgWorkspaceIdx: index("tacho_session_policy_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    modeCheck: check(
      "tacho_session_policy_mode_check",
      sql`${t.mode} IN ('observed', 'enforced')`,
    ),
    // "enforced" with nothing to enforce is the defect this table exists to
    // fix, wearing a switch. A row may not claim enforcement without at least
    // one clause the proxy can refuse on.
    enforcedCheck: check(
      "tacho_session_policy_enforced_check",
      sql`${t.mode} = 'observed' OR ${t.sessionLimitUsd} IS NOT NULL OR ${t.modelAllow} IS NOT NULL OR jsonb_array_length(${t.modelDeny}) > 0`,
    ),
    modelAllowCheck: check(
      "tacho_session_policy_model_allow_check",
      sql`${t.modelAllow} IS NULL OR jsonb_typeof(${t.modelAllow}) = 'array'`,
    ),
    modelDenyCheck: check(
      "tacho_session_policy_model_deny_check",
      sql`jsonb_typeof(${t.modelDeny}) = 'array'`,
    ),
  }),
);

/**
 * The wrapped-session policy table, for a database that may not have it yet.
 *
 * `information_schema.columns` has no row for a column of a table that does
 * not exist, so one ref answers for the whole table. That matters here for
 * the reason `GATEWAY_CHAIN_COLUMN` gives: querying an absent TABLE raises
 * 42P01, which aborts the transaction exactly as 42703 does — and this read
 * sits on the bundle path, which ingest, control polls and enrollment all
 * walk. Production applies migrations by hand from the app node while
 * `deploy-node` ships on merge, so the window is real.
 *
 * A pending migration reads as the observed-only policy, which is the
 * behaviour every host had before the table existed.
 */
export const TACHO_SESSION_POLICY_COLUMN = {
  schema: "workspace",
  table: "tacho_session_policy",
  column: "mode",
} as const;

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
    id: uuid("id").primaryKey().default(uuidv7Default),
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
