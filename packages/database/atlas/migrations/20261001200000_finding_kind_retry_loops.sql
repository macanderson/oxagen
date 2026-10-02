-- cost.findings gains the retry_loops kind (lane F15): detector 1's finding
-- for a call that failed 3 or more times in a row with the same error. It
-- claims frames as detector 1, so cost.finding_claims needs no change.
--
-- Written by hand against the drizzle schema (packages/database/src/schema/cost.ts,
-- `FINDING_KINDS`) in the shape `atlas migrate diff` emits. Every existing
-- kind stays.

-- Modify "findings" table
ALTER TABLE "cost"."findings" DROP CONSTRAINT "findings_kind_check", ADD CONSTRAINT "findings_kind_check" CHECK (kind = ANY (ARRAY['cache_writes_never_read'::text, 'duplicate_tool_calls'::text, 'repeated_shell_commands'::text, 'unpaged_results'::text, 'spin_loops'::text, 'standing_context'::text, 'idle_cache_rewrites'::text, 'cache_busts'::text, 'model_class_fit'::text, 'repeated_instructions'::text, 'recurring_runs'::text, 'spend_with_no_outcome'::text, 'retry_loops'::text]));
