-- 0016_child_table_org_scope.sql
--
-- Adds org_id (+ workspace_id where the parent has one) to child tables that
-- currently lack a tenant-scope column. Pattern:
--   1. Add column as nullable (expand).
--   2. Backfill via UPDATE…FROM parent table.
--   3. Set NOT NULL constraint.
--   4. Add index on (org_id) / (org_id, workspace_id).
--
-- Tables covered:
--   execution.execution_steps   → parent: execution.executions
--   execution.tool_calls        → parent: execution.execution_steps (after backfill)
--   agent.subagent_runs         → parent: agent.subagent_fanouts
--   agent.tool_versions         → parent: agent.tools
--   agent.tool_assignments      → parent: agent.agent_versions
--   workflow.playbook_step_assignments → parent: agent.agent_versions (agent_version_id)
--   event.workflow_triggers     → parent: event.triggers
--   billing.invoice_line_items  → parent: billing.invoices (org_id only; no workspace)
--
-- Down migration: DROP the added columns and their indexes. Safe because
-- zero live customers exist at migration time.

-- ── execution.execution_steps ────────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "execution"."execution_steps"
  ADD COLUMN IF NOT EXISTS "org_id" uuid,
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "execution"."execution_steps" es
SET
  org_id       = e.org_id,
  workspace_id = e.workspace_id
FROM "execution"."executions" e
WHERE es.execution_id = e.id;
--> statement-breakpoint
ALTER TABLE "execution"."execution_steps"
  ALTER COLUMN "org_id"       SET NOT NULL,
  ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_steps_org_idx"
  ON "execution"."execution_steps" ("org_id", "workspace_id");

-- ── execution.tool_calls ─────────────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "execution"."tool_calls"
  ADD COLUMN IF NOT EXISTS "org_id" uuid,
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "execution"."tool_calls" tc
SET
  org_id       = es.org_id,
  workspace_id = es.workspace_id
FROM "execution"."execution_steps" es
WHERE tc.execution_step_id = es.id;
--> statement-breakpoint
ALTER TABLE "execution"."tool_calls"
  ALTER COLUMN "org_id"       SET NOT NULL,
  ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_calls_org_idx"
  ON "execution"."tool_calls" ("org_id", "workspace_id");

-- ── agent.subagent_runs ──────────────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "agent"."subagent_runs"
  ADD COLUMN IF NOT EXISTS "org_id" uuid,
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "agent"."subagent_runs" sr
SET
  org_id       = sf.org_id,
  workspace_id = sf.workspace_id
FROM "agent"."subagent_fanouts" sf
WHERE sr.fanout_id = sf.id;
--> statement-breakpoint
ALTER TABLE "agent"."subagent_runs"
  ALTER COLUMN "org_id"       SET NOT NULL,
  ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subagent_runs_org_idx"
  ON "agent"."subagent_runs" ("org_id", "workspace_id");

-- ── agent.tool_versions ──────────────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "agent"."tool_versions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid,
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "agent"."tool_versions" tv
SET
  org_id       = t.org_id,
  workspace_id = t.workspace_id
FROM "agent"."tools" t
WHERE tv.tool_id = t.id;
--> statement-breakpoint
ALTER TABLE "agent"."tool_versions"
  ALTER COLUMN "org_id"       SET NOT NULL,
  ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_versions_org_idx"
  ON "agent"."tool_versions" ("org_id", "workspace_id");

-- ── agent.tool_assignments ───────────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "agent"."tool_assignments"
  ADD COLUMN IF NOT EXISTS "org_id" uuid,
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "agent"."tool_assignments" ta
SET
  org_id       = av.org_id,
  workspace_id = av.workspace_id
FROM "agent"."agent_versions" av
WHERE ta.agent_version_id = av.id;
--> statement-breakpoint
ALTER TABLE "agent"."tool_assignments"
  ALTER COLUMN "org_id"       SET NOT NULL,
  ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_assignments_org_idx"
  ON "agent"."tool_assignments" ("org_id", "workspace_id");

-- ── workflow.playbook_step_assignments ───────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "workflow"."playbook_step_assignments"
  ADD COLUMN IF NOT EXISTS "org_id" uuid,
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "workflow"."playbook_step_assignments" psa
SET
  org_id       = av.org_id,
  workspace_id = av.workspace_id
FROM "agent"."agent_versions" av
WHERE psa.agent_version_id = av.id;
--> statement-breakpoint
ALTER TABLE "workflow"."playbook_step_assignments"
  ALTER COLUMN "org_id"       SET NOT NULL,
  ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playbook_step_assignments_org_idx"
  ON "workflow"."playbook_step_assignments" ("org_id", "workspace_id");

-- ── event.workflow_triggers ──────────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE "event"."workflow_triggers"
  ADD COLUMN IF NOT EXISTS "org_id" uuid,
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "event"."workflow_triggers" wt
SET
  org_id       = tr.org_id,
  workspace_id = tr.workspace_id
FROM "event"."triggers" tr
WHERE wt.trigger_id = tr.id;
--> statement-breakpoint
ALTER TABLE "event"."workflow_triggers"
  ALTER COLUMN "org_id"       SET NOT NULL,
  ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_triggers_org_idx"
  ON "event"."workflow_triggers" ("org_id", "workspace_id");

-- ── billing.invoice_line_items (org_id only — invoices has no workspace_id) ──
--> statement-breakpoint
ALTER TABLE "billing"."invoice_line_items"
  ADD COLUMN IF NOT EXISTS "org_id" uuid;
--> statement-breakpoint
UPDATE "billing"."invoice_line_items" li
SET org_id = inv.org_id
FROM "billing"."invoices" inv
WHERE li.invoice_id = inv.id;
--> statement-breakpoint
ALTER TABLE "billing"."invoice_line_items"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_line_items_org_idx"
  ON "billing"."invoice_line_items" ("org_id");
