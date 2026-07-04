-- Drop verified-dead ("zombie") schema: tables and columns with zero producers
-- and zero consumers anywhere in the codebase (adversarially verified). No data
-- path reads or writes any of these, so the drop is behavior-preserving.
--
-- Hand-written + `atlas migrate hash` because `atlas migrate diff` is broken in
-- this repo (see prior migrations). The schema/*.ts edits and this migration
-- land together.
--
-- 1. ingestion.entity_types — the durable entity-type registry role moved to
--    ClickHouse internal.graph_observed_labels; this table was never written or
--    read. The live mapping work is done by ingestion.entity_type_mappings.
-- 2. workspace.workspaces.default_graph_id — no writer/reader anywhere.
-- 3. workflow.playbook_steps.{retry_policy,position_x,position_y} — canvas/retry
--    columns for a visual editor that does not exist; never written or read.
-- 4. workflow.playbook_versions.graph_hash — never written or read.
-- 5. workflow.playbook_runs.{parent_step_run_id,context_id} — never referenced.
-- 6. workflow.playbook_approvals.{requested_from_user_id,requested_from_role_id}
--    — approval routing was never wired; the approval insert omits both.
--
-- NOTE: ingestion.oauth_tokens was originally in this drop but is NOT dropped —
-- the connector poll/sync work (#558) wired it as a live per-connection OAuth
-- store (packages/inngest-functions/src/lib/resolve-connection-auth.ts).

DROP TABLE IF EXISTS "ingestion"."entity_types";

ALTER TABLE "workspace"."workspaces" DROP COLUMN IF EXISTS "default_graph_id";

ALTER TABLE "workflow"."playbook_steps" DROP COLUMN IF EXISTS "retry_policy";
ALTER TABLE "workflow"."playbook_steps" DROP COLUMN IF EXISTS "position_x";
ALTER TABLE "workflow"."playbook_steps" DROP COLUMN IF EXISTS "position_y";

ALTER TABLE "workflow"."playbook_versions" DROP COLUMN IF EXISTS "graph_hash";

ALTER TABLE "workflow"."playbook_runs" DROP COLUMN IF EXISTS "parent_step_run_id";
ALTER TABLE "workflow"."playbook_runs" DROP COLUMN IF EXISTS "context_id";

ALTER TABLE "workflow"."playbook_approvals" DROP COLUMN IF EXISTS "requested_from_user_id";
ALTER TABLE "workflow"."playbook_approvals" DROP COLUMN IF EXISTS "requested_from_role_id";
