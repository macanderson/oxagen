-- Drop ~18 verified-dead columns (2026-07-11 Postgres schema audit §3 +
-- per-column code-usage greps: written only via defaults, never read).
-- Column-dependent indexes (e.g. users_username_idx) drop automatically with
-- their column. NOT touched here: agent.background_tasks.inngest_run_id (live —
-- it is a returned contract output threaded through the chat stream + UI) and
-- iam.access_requests.* / workflow.playbook_approvals.* (Batch F wires them).

-- org / workspace membership: superseded by the IAM store (role_grants /
-- principal_role_assignments); the JSONB column was write-only ('{}').
ALTER TABLE "org"."org_users" DROP COLUMN IF EXISTS "permissions";
ALTER TABLE "workspace"."workspace_users" DROP COLUMN IF EXISTS "permissions";

-- chat: always-true decoy; branch reconstruction walks parent_message_id.
ALTER TABLE "chat"."messages" DROP COLUMN IF EXISTS "is_active_in_branch";

-- auth.users: Better Auth username plugin never integrated; verification
-- timestamp + last-login never written/read (boolean email_verified is the
-- real flag; two_factor_enabled is the real MFA signal). Dropping username
-- also drops its dependent unique index users_username_idx.
ALTER TABLE "auth"."users" DROP COLUMN IF EXISTS "username";
ALTER TABLE "auth"."users" DROP COLUMN IF EXISTS "email_verified_at";
ALTER TABLE "auth"."users" DROP COLUMN IF EXISTS "last_login_at";

-- iam.principals: enforcement lives on auth.users.two_factor_enabled.
ALTER TABLE "iam"."principals" DROP COLUMN IF EXISTS "mfa_status";

-- agent.agent_executions: per-run `debug` posture never written/read.
-- (`state` is NOT dropped — schema.reconcile.dispatch/status use it live, and
--  plugin.installed_plugins.config/auth_config are NOT dropped — plugin.org.list
--  reads and returns them; the audit missed these readers, caught by typecheck.)
ALTER TABLE "agent"."agent_executions" DROP COLUMN IF EXISTS "debug";

-- agent.a2a_tasks: "always null today"; subagent lineage is on
-- parent_execution_id, not this never-populated ref.
ALTER TABLE "agent"."a2a_tasks" DROP COLUMN IF EXISTS "fanout_run_id";

-- ingestion.setup_suggestions: suggest handler returns AI output directly;
-- persisted rows are never revisited, so resolution columns never written.
ALTER TABLE "ingestion"."setup_suggestions" DROP COLUMN IF EXISTS "resolved_at";
ALTER TABLE "ingestion"."setup_suggestions" DROP COLUMN IF EXISTS "resolved_by";

-- eval.eval_runs: never written (the working Inngest breadcrumb is
-- agent.subagent_fanouts.inngest_event_id, a different column).
ALTER TABLE "eval"."eval_runs" DROP COLUMN IF EXISTS "inngest_event_id";

-- schema_registry.node_labels: color/icon UI hints hardcoded '{}'; no UI.
ALTER TABLE "schema_registry"."node_labels" DROP COLUMN IF EXISTS "metadata";

-- cms.book_editions: seeded but never served — the book reader (apps/api CMS
-- redeem route + static apps/web read page with hardcoded OG tags) selects
-- explicit columns that exclude these two. Seed writes removed alongside.
ALTER TABLE "cms"."book_editions" DROP COLUMN IF EXISTS "description";
ALTER TABLE "cms"."book_editions" DROP COLUMN IF EXISTS "og_image_url";
