-- Index / constraint hardening (2026-07-11 Postgres schema audit).
--
-- §4.1 — add missing hot-path indexes.
-- §4.2 — drop provably-redundant duplicate indexes.
-- §5   item 4 (CHECK constraints on enum-shaped text) and item 1 (money
--       stored as float) — the audit's narrative numbering, i.e. "§5.4" /
--       "§5.1" in the remediation-phase table.
--
-- NOTE: the iam.principals (org_id, parent_user_id) unique index from §1.3 /
-- §4.1 item 2 is intentionally OMITTED here — it is already shipped by
-- Batch E1 (PR #1013, migration 20260802160000_principals_org_parent_user_uniq.sql)
-- to avoid a duplicate-index collision between the two PRs.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Atlas applies migrations inside a
-- single transaction and CONCURRENTLY cannot run inside one. All affected
-- tables are small in every environment this migration runs against.

-- ---------------------------------------------------------------------------
-- §4.1 — missing indexes
-- ---------------------------------------------------------------------------

-- 1. Activity feed / execution list (agent.execution.list.ts, command.menu.search.ts).
CREATE INDEX IF NOT EXISTS "agent_executions_org_ws_created_idx"
  ON "agent"."agent_executions" ("org_id", "workspace_id", "created_at" DESC);

-- 3. OAuth refresh watcher (30-min cross-tenant cron; no covering index today).
CREATE INDEX IF NOT EXISTS "credentials_oauth_expiring_idx"
  ON "mcp"."credentials" ("expires_at")
  WHERE "auth_kind" = 'oauth' AND "status" = 'active';

-- 4. Dispute webhook resolution (currently seq-scans).
CREATE INDEX IF NOT EXISTS "billing_disputes_payment_intent_idx"
  ON "billing"."billing_disputes" ("payment_intent_id")
  WHERE "payment_intent_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "billing_disputes_stripe_charge_idx"
  ON "billing"."billing_disputes" ("stripe_charge_id")
  WHERE "stripe_charge_id" IS NOT NULL;

-- 5. Invoices list (org page: WHERE org_id ORDER BY created_at DESC).
CREATE INDEX IF NOT EXISTS "invoices_org_created_idx"
  ON "billing"."invoices" ("org_id", "created_at" DESC);

-- 6. Session-expiry audit cron joins security_events on request_id with no
--    time bound today — unindexed, scans all history on a monthly-growing table.
CREATE INDEX IF NOT EXISTS "security_events_request_id_idx"
  ON "security"."security_events" ("request_id");

-- 7. Documents / generated-assets lists (unbounded, unindexed sort).
CREATE INDEX IF NOT EXISTS "documents_workspace_created_idx"
  ON "content"."documents" ("workspace_id", "created_at" DESC)
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "generated_assets_ws_kind_created_idx"
  ON "content"."generated_assets" ("workspace_id", "kind", "status", "created_at" DESC)
  WHERE "deleted_at" IS NULL;

-- 8. Batch reconcile cron (cross-tenant; existing index leads with org_id,
--    which is useless for this cross-tenant scan).
CREATE INDEX IF NOT EXISTS "ai_batch_jobs_open_idx"
  ON "ai"."batch_jobs" ("status")
  WHERE "status" IN ('submitted', 'in_progress') AND "deleted_at" IS NULL;

-- 9. Credit-ledger dispute/refund idempotency pre-checks. Distinct from the
--    existing partial unique index credit_ledger_grant_idempotency_idx, which
--    is scoped to reason LIKE 'grant_%' only — disputes.ts's refund pre-check
--    has no covering index today.
CREATE INDEX IF NOT EXISTS "credit_ledger_org_reason_ref_idx"
  ON "billing"."credit_ledger" ("org_id", "reason", "reference_type", "reference_id")
  WHERE "reference_type" IS NOT NULL AND "reference_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §4.2 — drop duplicate indexes (provably redundant)
-- ---------------------------------------------------------------------------

-- Duplicate of the workspace_memory_policy_workspace_id_unique constraint
-- (identical single column, both unique).
DROP INDEX IF EXISTS "workspace"."workspace_memory_policy_workspace_idx";

-- Same pattern as above, on workspace_budget_policy.
DROP INDEX IF EXISTS "workspace"."workspace_budget_policy_workspace_idx";

-- Duplicate of the PK on org_id (org_security_policy.org_id IS the PK).
DROP INDEX IF EXISTS "security"."org_security_policy_org_idx";

-- Duplicate of the leads_email_unique constraint (citext email, unique()).
DROP INDEX IF EXISTS "cms"."cms_leads_email_idx";

-- Strict prefix of the unique (org_id, slug) index — redundant.
DROP INDEX IF EXISTS "workspace"."workspaces_org_idx";

-- ---------------------------------------------------------------------------
-- §5 item 4 — missing CHECK constraints on enum-shaped text
-- ---------------------------------------------------------------------------

-- mcp.mcp_servers: health_status / transport_type / auth_strategy were plain
-- unconstrained text. Value sets confirmed against live write paths:
--   health_status  — agent.mcp.set_enabled.ts, plugin.set_enabled.ts,
--                     oauth/callback route ('healthy' | 'degraded' |
--                     'unreachable' | 'unknown').
--   transport_type — agent.mcp.register/list contracts declare
--                     ('streamable-http' | 'stdio'), but the live
--                     "connect a custom MCP server" flow
--                     (mcp-actions.ts → plugin.org.install →
--                     plugin.set_enabled.ts:132) also writes 'sse' — the
--                     UI explicitly offers SSE as a transport option, so
--                     'sse' MUST be included or that flow starts throwing.
--   auth_strategy  — agent.mcp.resolve.ts / plugin-types/mcp.ts /
--                     file-mcp.ts ('none' | 'bearer' | 'header').
ALTER TABLE "mcp"."mcp_servers"
  ADD CONSTRAINT "mcp_servers_health_status_check"
  CHECK ("health_status" IN ('healthy', 'degraded', 'unreachable', 'unknown'));
ALTER TABLE "mcp"."mcp_servers"
  ADD CONSTRAINT "mcp_servers_transport_type_check"
  CHECK ("transport_type" IN ('streamable-http', 'sse', 'stdio'));
ALTER TABLE "mcp"."mcp_servers"
  ADD CONSTRAINT "mcp_servers_auth_strategy_check"
  CHECK ("auth_strategy" IN ('none', 'bearer', 'header'));

-- mcp.catalog_servers: status / auth_kind documented in column comments but
-- never enforced ("Registry-managed status: active | deprecated | deleted";
-- "Derived auth kind: oauth | secret | none" — same vocabulary as
-- installed_plugins.auth_kind / mcp_servers.auth_strategy's oauth|secret arm).
ALTER TABLE "mcp"."catalog_servers"
  ADD CONSTRAINT "catalog_servers_status_check"
  CHECK ("status" IN ('active', 'deprecated', 'deleted'));
ALTER TABLE "mcp"."catalog_servers"
  ADD CONSTRAINT "catalog_servers_auth_kind_check"
  CHECK ("auth_kind" IN ('oauth', 'secret', 'none'));

-- ingestion.setup_suggestions.status: only 'pending' is ever written
-- (connection.mappings.suggest.ts); the column comment "so the user can
-- accept/reject them" plus the dead resolved_at/resolved_by columns confirm
-- the intended terminal states.
ALTER TABLE "ingestion"."setup_suggestions"
  ADD CONSTRAINT "setup_suggestions_status_check"
  CHECK ("status" IN ('pending', 'accepted', 'rejected'));

-- ingestion.webhook_subscriptions.status: no write path exists yet (§1.6 —
-- feature intent only), so this constrains the column to the lifecycle
-- vocabulary the read side (apps/api webhook route) and sibling status
-- columns already use, ahead of the provisioning work landing.
ALTER TABLE "ingestion"."webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_status_check"
  CHECK ("status" IN ('active', 'paused', 'revoked', 'error'));

-- ---------------------------------------------------------------------------
-- §5 item 1 — money stored as float
-- ---------------------------------------------------------------------------

-- workspace.workspace_budget_policy.limit_usd: real (float4) feeding direct
-- comparisons/arithmetic in packages/billing/src/turn-budget.ts. Convert to
-- numeric(12,2) for exact decimal comparisons.
ALTER TABLE "workspace"."workspace_budget_policy"
  ALTER COLUMN "limit_usd" TYPE numeric(12, 2) USING "limit_usd"::numeric(12, 2);
