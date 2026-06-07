export type PolicyClass =
  | "standard"
  | "workspace_nullable"
  | "org_only"
  | "workspace_only"
  // org_or_global: org_id is NULLABLE — NULL rows are a shared/global catalog
  // visible to every tenant, non-NULL rows are tenant-private. Used by
  // mcp.registries (global default-seed registry + optional per-org registries).
  | "org_or_global";

export interface PolicyEntry {
  readonly table: string; // schema-qualified (schema.table_name)
  readonly policyClass: PolicyClass;
}

// Source of truth for which RLS policy each tenant-owned table gets.
// A CI test (integration/manifest-coverage.test.ts) asserts every org_id
// column in the live schema appears here, so a new owned table can't slip
// through.
//
// SCHEMA NOTE (OXA-1515): The plan listed IAM tables under `iam.*` but the
// actual Drizzle schema places ALL IAM tables in the `org` Postgres schema
// (orgSchema from _schemas.ts). Table names are confirmed from schema/*.ts.
export const POLICY_MANIFEST: readonly PolicyEntry[] = [
  // ── agent.* (orgScopeMixin: org_id + workspace_id NOT NULL) ──────────────
  { table: "agent.agents", policyClass: "standard" },
  { table: "agent.agent_versions", policyClass: "standard" },
  { table: "agent.tools", policyClass: "standard" },
  { table: "agent.skills", policyClass: "standard" },
  { table: "agent.skill_versions", policyClass: "standard" },
  { table: "agent.background_tasks", policyClass: "standard" },
  { table: "agent.approval_requests", policyClass: "standard" },
  { table: "agent.subagent_fanouts", policyClass: "standard" },
  { table: "agent.subagent_runs", policyClass: "standard" },
  { table: "agent.plan_steps", policyClass: "standard" },
  { table: "agent.mcp_servers", policyClass: "standard" },
  { table: "agent.workflow_runs", policyClass: "standard" },
  { table: "agent.workflow_run_tasks", policyClass: "standard" },

  // ── workflow.* (orgScopeMixin) ────────────────────────────────────────────
  { table: "workflow.playbooks", policyClass: "standard" },
  { table: "workflow.playbook_versions", policyClass: "standard" },
  { table: "workflow.playbook_steps", policyClass: "standard" },

  // ── event.* (orgScopeMixin) ───────────────────────────────────────────────
  { table: "event.triggers", policyClass: "standard" },

  // ── execution.* (org_id + workspace_id, inline or via orgScopeMixin) ──────
  { table: "execution.executions", policyClass: "standard" },
  { table: "execution.execution_steps", policyClass: "standard" },
  { table: "execution.tool_calls", policyClass: "standard" },

  // ── chat.* (orgScopeMixin) ────────────────────────────────────────────────
  { table: "chat.conversations", policyClass: "standard" },
  { table: "chat.messages", policyClass: "standard" },

  // ── content.* (orgScopeMixin) ─────────────────────────────────────────────
  { table: "content.files", policyClass: "standard" },
  { table: "content.generated_assets", policyClass: "standard" },
  { table: "content.documents", policyClass: "standard" },

  // ── integration.* (orgScopeMixin) ────────────────────────────────────────
  { table: "integration.connections", policyClass: "standard" },

  // ── workspace.* ───────────────────────────────────────────────────────────
  //   workspaces has org_id NOT NULL but no workspace_id — org_only policy.
  //   folders use orgScopeMixin (org_id + workspace_id). workspace_users is the
  //   membership table: it has workspace_id + user_id but NO org_id, so it
  //   cannot use an org-keyed policy. It gets a workspace_only policy keyed on
  //   app.current_workspace_id — without it the table has NO RLS and member
  //   rows leak across tenants (OXA-1515).
  { table: "workspace.workspaces", policyClass: "org_only" },
  { table: "workspace.folders", policyClass: "standard" },
  { table: "workspace.workspace_users", policyClass: "workspace_only" },

  // ── auth.* — credentials + api_keys use orgScopeMixin ────────────────────
  // Better Auth tables (users/sessions/accounts/verifications/user_preferences)
  // are NOT row-scoped (no org_id). credentials and api_keys are org+workspace.
  { table: "auth.credentials", policyClass: "standard" },
  { table: "auth.api_keys", policyClass: "standard" },

  // ── org.* — IAM tables live in the `org` Postgres schema (NOT `iam.*`).
  //   principals and principal_role_assignments are workspace_nullable
  //   (org_id NOT NULL, workspace_id nullable per schema).
  //   All other IAM + membership tables are org_only. ──────────────────────
  { table: "org.principals", policyClass: "workspace_nullable" },
  { table: "org.principal_role_assignments", policyClass: "workspace_nullable" },
  { table: "org.roles", policyClass: "org_only" },
  { table: "org.role_grants", policyClass: "org_only" },
  { table: "org.grants", policyClass: "org_only" },
  { table: "org.policies", policyClass: "org_only" },
  { table: "org.access_requests", policyClass: "org_only" },
  { table: "org.iam_sessions", policyClass: "org_only" },
  { table: "org.org_users", policyClass: "org_only" },
  { table: "org.invitations", policyClass: "org_only" },

  // ── billing.* (org_id only; no workspace_id on any billing table) ─────────
  // stripe_event_processing excluded: no org_id column.
  // stripe_events excluded: no org_id column (shared catalog).
  // plans excluded: shared catalog.
  { table: "billing.subscriptions", policyClass: "org_only" },
  { table: "billing.payment_methods", policyClass: "org_only" },
  { table: "billing.invoices", policyClass: "org_only" },
  { table: "billing.invoice_line_items", policyClass: "org_only" },
  { table: "billing.usage_records", policyClass: "org_only" },
  { table: "billing.credit_balances", policyClass: "org_only" },
  { table: "billing.credit_ledger", policyClass: "org_only" },
  { table: "billing.credit_lots", policyClass: "org_only" },
  { table: "billing.org_billing_profiles", policyClass: "org_only" },
  { table: "billing.org_billing_settings", policyClass: "org_only" },
  { table: "billing.billing_disputes", policyClass: "org_only" },

  // ── security.* (org_id NOT NULL, workspace_id nullable) ──────────────────
  { table: "security.security_events", policyClass: "workspace_nullable" },

  // ── Installable-plugins epic (schemas plugin / mcp / notification) ─────────
  //   Added by migration 0008 AFTER the 0001 baseline, so their RLS is applied
  //   by the forward migration 0010_plugin_mcp_notification_rls.sql — NOT by
  //   regenerating 0001 (these tables don't exist when 0001 runs on a fresh DB).
  //   mcp.catalog_servers is intentionally omitted: it is a shared catalog with
  //   no org_id column.
  { table: "plugin.org_listings", policyClass: "org_only" },
  { table: "plugin.org_denylist", policyClass: "org_only" },
  { table: "mcp.credentials", policyClass: "standard" }, // encrypted OAuth tokens — org+workspace scoped
  { table: "mcp.registries", policyClass: "org_or_global" }, // NULL org_id = global default seed
  { table: "notification.notifications", policyClass: "workspace_nullable" },
];
