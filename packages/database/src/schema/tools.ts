// tools.* — mandates and their ledger (MC spec §6.9 part 3, App. A.5;
// ADR-059). A mandate is bounded, expiring authority for a consequence,
// granted by a human holding the role the workspace names for that
// consequence to one agent, within limits over the tool's declared measures.
// The ledger is where remaining authority lives: reservations at decision
// time, settlements at receipt time, releases on failure or denial.
// The toolbelts (ADR-198) sit at the end of the file.
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { toolsSchema } from "./_schemas";
import {
  appendOnlyAuditMixin,
  auditMixin,
  citext,
  idMixin,
  orgScopeMixin,
  softDeleteMixin,
  uuidv7Default,
} from "./_mixins";

// Cross-domain references (agent_principal_id → iam.principals, the user ids
// → auth.users) are app-enforced; FKs stay within the schema per the storage
// rules in CLAUDE.md, as agent.approval_requests does.
export const mandates = toolsSchema.table(
  "mandates",
  {
    ...idMixin("mnd"),
    ...auditMixin(),
    ...orgScopeMixin(),
    agentPrincipalId: uuid("agent_principal_id").notNull(),
    // The operator who asked (request_mandate); null on a direct grant.
    requestedBy: uuid("requested_by"),
    // The granter and the role that authorised the grant; null while a draft.
    grantedBy: uuid("granted_by"),
    roleAtGrant: text("role_at_grant"),
    consequenceTags: text("consequence_tags").array().notNull(),
    // measure → { perCall?, perPeriod?, period, currencyOrUnit }; values are
    // integer strings (micros for a currency, whole units otherwise).
    limits: jsonb("limits").notNull(),
    // measure → { allow: string[], deny: string[] } glob patterns over a text
    // measure read from the call.
    targets: jsonb("targets").notNull().default(sql`'{}'::jsonb`),
    // Glob patterns over `slug@version` (or `slug`) of declared tools.
    tools: text("tools").array().notNull(),
    // { humanAbove: { measure: value }, alwaysHumanFor: tag[], approvers: string[] }
    approvalRules: jsonb("approval_rules").notNull().default(sql`'{}'::jsonb`),
    purpose: text("purpose").notNull(),
    validFrom: timestamp("valid_from", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    validTo: timestamp("valid_to", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    status: text("status").notNull().default("active"),
    revokedBy: uuid("revoked_by"),
    revokedReason: text("revoked_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // The gate's lookup: this agent's active mandates in this workspace.
    agentStatusIdx: index("mandates_agent_status_idx").on(
      t.orgId,
      t.workspaceId,
      t.agentPrincipalId,
      t.status,
    ),
    // The expiry job's scan.
    statusValidToIdx: index("mandates_status_valid_to_idx").on(
      t.status,
      t.validTo,
    ),
    orgIdx: index("mandates_org_idx").on(t.orgId, t.workspaceId),
    statusCheck: check(
      "mandates_status_check",
      sql`${t.status} IN ('draft', 'active', 'expired', 'revoked')`,
    ),
    validityCheck: check(
      "mandates_validity_check",
      sql`${t.validTo} > ${t.validFrom}`,
    ),
    // A grant carries its granter and role; a draft carries neither, and a
    // revoked row may be a declined draft.
    grantCheck: check(
      "mandates_grant_check",
      sql`(${t.status} IN ('draft', 'revoked')) OR (${t.grantedBy} IS NOT NULL AND ${t.roleAtGrant} IS NOT NULL)`,
    ),
  }),
);

// Append-only: the application role holds SELECT and INSERT only (the
// migration revokes UPDATE and DELETE). One row is one movement for one
// measure of one mandate in one period; balance_after is the remaining
// authority after the row (ADR-059 decision 5).
export const mandateLedger = toolsSchema.table(
  "mandate_ledger",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    mandateId: uuid("mandate_id")
      .notNull()
      .references(() => mandates.id),
    // The call the movement belongs to (app-enforced; control.tool_calls is
    // not in the tree). Minted by the gate per decision, carried on the
    // approval row that parks the call.
    toolCallId: uuid("tool_call_id").notNull(),
    kind: text("kind").notNull(),
    measure: text("measure").notNull(),
    value: numeric("value").notNull(),
    unitOrCurrency: text("unit_or_currency").notNull(),
    // The mandate limit's kind (ADR-108) at the instant this row was
    // written: "money" or "count", stamped from the live tool declaration
    // the call was decided against, never from `mandateLimitSchema.kind`
    // (a legacy mandate's stored kind is only a guess) and never
    // re-derived afterward. The ledger is append-only and outlives a limit a
    // later `update_mandate_limits` whole-record replacement can remove, so
    // this is the one place a deleted measure's historical kind survives.
    // Nullable because a row written before this column existed has no
    // value; a reader falls back to `legacyMeasureKindGuess` for those,
    // same as `withResolvedKinds` does for a limit with no stored kind.
    measureKind: text("measure_kind"),
    // The transaction, migration, message or deployment id; settle rows only.
    externalEffectId: text("external_effect_id"),
    periodKey: text("period_key").notNull(),
    balanceAfter: numeric("balance_after").notNull(),
  },
  (t) => ({
    // The database backstop against a double movement (INV-30's pattern).
    movementUniq: uniqueIndex("mandate_ledger_movement_uniq").on(
      t.mandateId,
      t.toolCallId,
      t.measure,
      t.kind,
    ),
    // The balance read: the latest row of a measure in a period.
    balanceIdx: index("mandate_ledger_balance_idx").on(
      t.mandateId,
      t.measure,
      t.periodKey,
      t.createdAt,
    ),
    callIdx: index("mandate_ledger_call_idx").on(t.toolCallId),
    orgIdx: index("mandate_ledger_org_idx").on(t.orgId, t.workspaceId),
    kindCheck: check(
      "mandate_ledger_kind_check",
      sql`${t.kind} IN ('reserve', 'settle', 'release')`,
    ),
    valueCheck: check("mandate_ledger_value_check", sql`${t.value} >= 0`),
  }),
);

// ── toolbelts (ADR-198) ──────────────────────────────────────────────────────
// A toolbelt is the set of tools an agent is shown. It narrows what the agent
// can reach and never widens a grant: roles, mandates and kill switches still
// decide each call.
//
// Every workspace holds one `all_tools` belt, created the first time a
// toolbelt path touches the workspace. It stores no member rows: its members
// are every tool an owner or admin made available (`agent.tools.enabled`),
// each active as its `default_active` says. A `custom` belt is a clone: it
// stores one row per tool it holds, active or not, copied from the belt it
// was cloned from and edited from there.
export const toolbelts = toolsSchema.table(
  "toolbelts",
  {
    ...idMixin("tbt"),
    ...auditMixin(),
    ...orgScopeMixin(),
    ...softDeleteMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("custom"),
    // The belt this one was cloned from; null on the All tools belt.
    clonedFromId: uuid("cloned_from_id").references(
      (): AnyPgColumn => toolbelts.id,
    ),
  },
  (t) => ({
    workspaceSlugUniq: uniqueIndex("toolbelts_workspace_slug_uniq")
      .on(t.workspaceId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    // One All tools belt per workspace; the partial index makes the lazy
    // create race-safe (INSERT ... ON CONFLICT DO NOTHING).
    allToolsUniq: uniqueIndex("toolbelts_all_tools_uniq")
      .on(t.workspaceId)
      .where(sql`${t.kind} = 'all_tools' AND ${t.deletedAt} IS NULL`),
    orgIdx: index("toolbelts_org_idx").on(t.orgId, t.workspaceId),
    kindCheck: check(
      "toolbelts_kind_check",
      sql`${t.kind} IN ('all_tools', 'custom')`,
    ),
    slugCheck: check(
      "toolbelts_slug_check",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) <= 40`,
    ),
  }),
);

// A custom belt's members. `tool_id` is an agent.tools row (app-enforced, no
// cross-schema FK). Removing a server from a belt deletes its rows; turning a
// server or a tool off in a belt clears `active` and keeps the row.
export const toolbeltTools = toolsSchema.table(
  "toolbelt_tools",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    ...auditMixin(),
    ...orgScopeMixin(),
    toolbeltId: uuid("toolbelt_id")
      .notNull()
      .references(() => toolbelts.id),
    toolId: uuid("tool_id").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    memberUniq: uniqueIndex("toolbelt_tools_member_uniq").on(
      t.toolbeltId,
      t.toolId,
    ),
    toolIdx: index("toolbelt_tools_tool_idx").on(t.toolId),
    orgIdx: index("toolbelt_tools_org_idx").on(t.orgId, t.workspaceId),
  }),
);
