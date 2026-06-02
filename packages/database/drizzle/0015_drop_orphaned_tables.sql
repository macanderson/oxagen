-- 0015_drop_orphaned_tables.sql
--
-- Drops the 10 orphaned tables that were removed from the TypeScript schema
-- in the release-audit workstream. All tables have zero CRUD (no application
-- code references them) and zero live customers at the time of this migration.
-- ORDER matters: child tables with FKs before their parents.
--
-- Down migration: recreate the tables from the 0000_init.sql DDL. Not
-- automated because this is a deliberate, irreversible removal of dead schema.

--> statement-breakpoint
-- eval_runs references evals (FK with CASCADE) — drop child first.
DROP TABLE IF EXISTS "evaluation"."eval_runs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "evaluation"."evals" CASCADE;
--> statement-breakpoint
-- routing_rules references graph_providers — drop child first.
DROP TABLE IF EXISTS "graph"."routing_rules" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "graph"."graph_providers" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "integration"."connection_sync_jobs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "org"."org_slug_history" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "workspace"."workspace_slug_history" CASCADE;
--> statement-breakpoint
-- Previously-removed tables (already gone from TS schema, now reconciled in SQL).
-- prompt_template_versions references prompt_templates (CASCADE) — child first.
DROP TABLE IF EXISTS "workflow"."prompt_template_versions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "workflow"."prompt_templates" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "content"."content_generations" CASCADE;
