-- Finish the runtime excision on the KEPT tables — ADR-041 follow-up.
--
-- 20260907120000_drop_agent_runtime_tables.sql dropped the runtime's own
-- tables. This migration cleans up what it deliberately left behind: one table
-- whose transport went with the runtime, five dead worker columns on the
-- evidence ledger's run row, and two CHECK constraints still spelling the
-- pre-ADR-041 vocabulary.
--
-- Like its predecessor this is a CONTRACT migration: every reader of the
-- dropped table and columns was removed in the same body of work, and
-- packages/run-ledger — the only writer of agent.agent_runs* — never named any
-- of them. Recovery is from git history plus a restore.
--
-- Idempotent throughout: IF EXISTS on every drop, and the two CHECKs are
-- dropped and re-created rather than altered (Postgres has no ALTER CONSTRAINT
-- for a CHECK expression).

-- ════════════════════════════════════════════════════════════════════════════
-- 1. agent.a2a_tasks — the A2A transport's durable task store
-- ════════════════════════════════════════════════════════════════════════════
-- ADR-041 retired `a2a.card.get` and the POST /a2a JSON-RPC surface that this
-- table was the durable state for. Nothing outside packages/database referenced
-- it afterwards. CASCADE takes its four indexes, its state CHECK, its
-- tenant_isolation policy and its grants with it.
DROP TABLE IF EXISTS "agent"."a2a_tasks" CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. agent.agent_runs — the durable worker's claim/lease/checkpoint columns
-- ════════════════════════════════════════════════════════════════════════════
-- The worker that claimed a run, held a lease on it, counted its own retries
-- and checkpointed engine state between them is gone. Oxagen admits and
-- stamps; an external engine executes and submits.
--
--   claimed_by       owning worker identity          — nobody claims
--   lease_expires_at lease horizon for the sweeper   — nothing is leased
--   attempts         V1 retry counter                — superseded by
--                                                      attempt_count, which is
--                                                      bounded by the pinned
--                                                      max_attempts ceiling
--   checkpoint       latest engine state blob        — Oxagen restores nothing
--   checkpoint_seq   its sequence pointer            — ditto
--
-- No index or CHECK names any of them (agent_runs_claim_idx and
-- agent_runs_v2_claim_idx are on (status, created_at) and survive as the
-- operator-facing "which runs are still open" indexes), and the
-- agent_runs_v2_immutability trigger body does not reference them either — so
-- these DROPs invalidate nothing that has to be re-created.
ALTER TABLE "agent"."agent_runs"
  DROP COLUMN IF EXISTS "claimed_by",
  DROP COLUMN IF EXISTS "lease_expires_at",
  DROP COLUMN IF EXISTS "attempts",
  DROP COLUMN IF EXISTS "checkpoint",
  DROP COLUMN IF EXISTS "checkpoint_seq";

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Widen two CHECKs to the post-runtime vocabulary
-- ════════════════════════════════════════════════════════════════════════════
-- Both are EXPAND-only: every value the old constraint admitted still passes,
-- so no existing row can be invalidated and no backfill is needed. The retired
-- values are kept precisely because history carries them — narrowing them would
-- make already-written evidence unrepresentable.

-- A seal is stamped by evidence ingress now, not by a worker Oxagen supervised
-- or by the lease reclaimer that swept it. `ingress` is the only kind
-- packages/run-ledger writes after this migration.
ALTER TABLE "agent"."agent_run_attempt_seals"
  DROP CONSTRAINT IF EXISTS "agent_run_attempt_seals_sealer_kind_check";

ALTER TABLE "agent"."agent_run_attempt_seals"
  ADD CONSTRAINT "agent_run_attempt_seals_sealer_kind_check" CHECK (
    sealer_kind IN ('ingress', 'worker', 'reclaimer')
  );

-- A `client_attested` submission (ADR-041 §3) is admitted by no interactive
-- Oxagen surface — the engine ran elsewhere — so it needs a surface value of
-- its own. `external` is that value; it completes PlatformSurface in
-- packages/run-ledger/src/surface.ts.
ALTER TABLE "agent"."agent_runs"
  DROP CONSTRAINT IF EXISTS "agent_runs_surface_check";

ALTER TABLE "agent"."agent_runs"
  ADD CONSTRAINT "agent_runs_surface_check" CHECK (
    surface IN ('chat', 'api-chat', 'a2a', 'repo-edit', 'external')
  );
