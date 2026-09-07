-- Drop the agent-runtime Postgres surface — ADR-041 (runtime excision).
--
-- Oxagen governs agents; it does not run them. Everything dropped here is
-- EXECUTION state for a first-party runtime that no longer exists in this
-- repository (Stella owns the engine, sandboxing, skills authoring, replay and
-- the verification ladder). None of it carries evidence value: the durable
-- evidence ledger — agent_runs / agent_run_events / agent_run_attempts /
-- agent_run_attempt_seals / agent_run_finalization_{grants,obligations} — is
-- deliberately NOT touched by this migration.
--
-- This is a CONTRACT migration (the destructive half of an expand/contract
-- pair): every reader of these tables was removed in the same body of work, so
-- there is no application left to break. Recovery, if it were ever needed, is
-- from git history at 9711041769218ab6f8ed2b63b33e77aa5ecd5b83 plus a restore.
--
-- Ordering: children before parents, then the now-empty schemas. Every DROP
-- carries CASCADE so dependent policies, grants, indexes, sequences and FK
-- constraints go with the table rather than blocking it, and IF EXISTS so the
-- migration is idempotent against a database that never had a given table.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. agent.* — runtime execution state
-- ════════════════════════════════════════════════════════════════════════════
-- Skills authoring (ADR-008, retired). skills.active_version_id FKs into
-- skill_versions, so the identity table goes first.
DROP TABLE IF EXISTS "agent"."skills" CASCADE;
DROP TABLE IF EXISTS "agent"."skill_versions" CASCADE;

-- Inngest-backed background task tracking (agent.background_task.*, retired).
DROP TABLE IF EXISTS "agent"."background_tasks" CASCADE;

-- Subagent fan-out (ADR-010, retired). Child rows before the aggregate.
DROP TABLE IF EXISTS "agent"."subagent_runs" CASCADE;
DROP TABLE IF EXISTS "agent"."subagent_fanouts" CASCADE;

-- Durable code-agent sandbox sessions (ADR-007/ADR-011, retired).
DROP TABLE IF EXISTS "agent"."sandbox_sessions" CASCADE;

-- Structured execution plans with approval gates (agent.plan.*, retired).
DROP TABLE IF EXISTS "agent"."agent_plans" CASCADE;

-- File-lock authority + fencing-token counter (ADR-021 §5, retired with the
-- coding pipeline that mutated a working tree).
DROP TABLE IF EXISTS "agent"."file_locks" CASCADE;
DROP TABLE IF EXISTS "agent"."file_lock_fences" CASCADE;

-- Engine-state checkpoints and the mutable fenced worker lease. Both exist only
-- so a worker can claim, execute and resume a run in-process; with no worker
-- there is nothing to fence and no engine state to restore. The attempt
-- identity, its seal, and the finalization grant/obligation chain — the parts
-- that are evidence rather than execution — are kept.
DROP TABLE IF EXISTS "agent"."agent_run_checkpoints" CASCADE;
DROP TABLE IF EXISTS "agent"."agent_run_attempt_leases" CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Kept tables — columns whose only referent was a dropped table
-- ════════════════════════════════════════════════════════════════════════════
-- agent.agent_runs.latest_checkpoint_id pointed at agent_run_checkpoints.
-- (The agent_runs_v2_immutability trigger never names this column, so dropping
-- it does not invalidate the function body.)
ALTER TABLE "agent"."agent_runs"
  DROP COLUMN IF EXISTS "latest_checkpoint_id";

-- agent.agent_run_attempts kept the four-part restore tuple: which attempt was
-- resumed and which checkpoint was restored. The checkpoint half is gone, so
-- the tuple narrows to the attempt-provenance pair. Dropping a column also
-- drops every CHECK that mentions it, so both constraints are re-added below in
-- their narrowed form (Postgres drops them silently — re-adding is not
-- optional).
ALTER TABLE "agent"."agent_run_attempts"
  DROP COLUMN IF EXISTS "restored_checkpoint_id",
  DROP COLUMN IF EXISTS "restored_checkpoint_digest";

ALTER TABLE "agent"."agent_run_attempts"
  DROP CONSTRAINT IF EXISTS "agent_run_attempts_restore_tuple_check",
  DROP CONSTRAINT IF EXISTS "agent_run_attempts_digest_check";

ALTER TABLE "agent"."agent_run_attempts"
  -- A partial restore reference cannot prove provenance, so the pair is
  -- all-or-nothing, exactly as the four-part tuple was.
  ADD CONSTRAINT "agent_run_attempts_restore_tuple_check" CHECK (
    (
      resumed_from_attempt_id IS NULL
      AND resumed_from_attempt_public_id IS NULL
    ) OR (
      resumed_from_attempt_id IS NOT NULL
      AND resumed_from_attempt_public_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT "agent_run_attempts_digest_check" CHECK (
    engine_build_digest ~ '^sha256:[0-9a-f]{64}$'
  );

-- environments.agent_environment_bindings.sandbox_template_id pointed at
-- environments.sandbox_templates (dropped below). A binding now names an
-- environment and nothing else. No index existed on this column.
ALTER TABLE "environments"."agent_environment_bindings"
  DROP COLUMN IF EXISTS "sandbox_template_id";

-- ════════════════════════════════════════════════════════════════════════════
-- 3. environments.* — sandbox templates
-- ════════════════════════════════════════════════════════════════════════════
-- Portable sandbox configuration + its preloaded tool set. Environments,
-- secret_keys, secret_values, secret_access_log and agent_environment_bindings
-- are the credential vault and stay.
DROP TABLE IF EXISTS "environments"."sandbox_template_tools" CASCADE;
DROP TABLE IF EXISTS "environments"."sandbox_templates" CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. ai.* — Message Batches tracking
-- ════════════════════════════════════════════════════════════════════════════
-- ai.batch_jobs was the durable record for @oxagen/ai submitBatch/pollBatch.
-- Nothing ever read or wrote it (the batch helpers call the provider API
-- directly), so it is dead schema either way. ai.response_cache stays.
DROP TABLE IF EXISTS "ai"."batch_jobs" CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. ingestion.* — governed repository selection
-- ════════════════════════════════════════════════════════════════════════════
-- The explicit primary-repository pointer existed so run admission could decide
-- which repository an agent was allowed to EDIT. Oxagen no longer edits
-- repositories. repository_bindings + repository_binding_heads stay: they are
-- the immutable binding evidence trail.
DROP TABLE IF EXISTS "ingestion"."governed_repository_selections" CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. content.documents — the authored-document store
-- ════════════════════════════════════════════════════════════════════════════
-- Backed document.create / document.list / document.read, all retired. The
-- `content` SCHEMA and `content.generated_assets` deliberately SURVIVE: that
-- row is the reference/provenance record for chat and agent ATTACHMENTS
-- (asset.upload's `user_upload` branch, conversation.attachment.add,
-- conversation.files.list). Uploading a file and asking the governance agent
-- about it is a governance-plane feature, so ADR-041 §1's blanket `content.*`
-- line is over-broad and only the documents half applies.
DROP TABLE IF EXISTS "content"."documents" CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Whole domains that were runtime-only
-- ════════════════════════════════════════════════════════════════════════════
-- Every table, enum, index and policy in these three schemas belonged to a
-- retired surface, so the schema namespace goes with them rather than being
-- left behind empty:
--
--   eval      eval_datasets, eval_dataset_items, eval_runs               (eval.*)
--   workflow  playbooks, playbook_versions, playbook_steps, playbook_edges,
--             playbook_triggers, playbook_runs, playbook_step_runs,
--             playbook_events, playbook_approvals                    (workflow.*)
--   cms       leads, book_editions, book_access_codes, plus the
--             cms.company_size and cms.referral_source enums
--
-- CASCADE takes the enums and any remaining dependent objects with the schema.
DROP SCHEMA IF EXISTS "eval" CASCADE;
DROP SCHEMA IF EXISTS "workflow" CASCADE;
DROP SCHEMA IF EXISTS "cms" CASCADE;
