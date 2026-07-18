-- agent.agent_runs + agent.agent_run_events — durable-run schema for
-- agent-engine v2 Phase 2a (docs/specs/agent-engine-v2/plan.md, Phase 2).
--
-- Purpose: the two tables every other Phase-2 piece (worker pool, checkpoint
-- writer, SSE resume subscription, ClickHouse ingestion, ADR-028 replay)
-- builds on top of. `executeTurn` (packages/agent-runner) starts persisting a
-- run row per turn here, across every platform surface.
--
-- Design:
--   - agent_runs: one row per turn. `spec` is the serialized RunSpec
--     (instruction, model, option snapshot) — never the live engine
--     ports/callbacks a worker constructs in-process from it. Durable
--     claim/lease (claimed_by / lease_expires_at / attempts) is the exact
--     pattern agent.execute-subagent.ts already uses on subagent_runs: claim
--     via a single atomic UPDATE ... FOR UPDATE SKIP LOCKED, lease heartbeat,
--     sweeper requeues expired-lease rows until the attempt cap. Deliberate
--     difference from subagent_runs: the claim query here is cross-org (a
--     small dedicated worker pool claims ANY pending run via withSystemDb,
--     not one org's queue), so agent_runs_claim_idx carries no org_id prefix
--     — unlike subagent_runs_claim_idx (org_id, status).
--   - agent_run_events: append-only event log, the canonical source for
--     resumable SSE, ClickHouse tailing, and replay (spec.md §4.2). Immutable
--     child — bare uuid pk (no public_id; nothing external addresses one
--     event row directly), no updated_at. `seq` is app-assigned and
--     monotonic per run starting at 1 (not a serial/identity column) so the
--     worker can assert the exact next value in the same transaction as the
--     checkpoint write; UNIQUE(run_id, seq) turns a racing double-append into
--     a constraint violation instead of silent duplication.
--
-- Notes:
--   - The agent schema already exists; no CREATE SCHEMA needed.
--   - No cross-schema/cross-table FK .references(); app-enforced per CLAUDE.md
--     storage rules (run_id on agent_run_events is not a real FK, same
--     convention as file_locks.execution_id).
--   - RLS follows the tenant_isolation pattern from 20260612140000, same
--     shape as 20260708130000_agent_file_locks.sql.
--   - oxagen_app grant is additive + idempotent (schema-level grants preexist).
--   - Hand-written (not `atlas migrate diff`): `atlas migrate diff` is broken
--     by the unresolved pg_trgm fresh-replay defect
--     (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md), the
--     same reason 20260703150000_phase2_claim_lease.sql and every migration
--     since is hand-written + `atlas migrate hash`.

-- ── agent.agent_runs ──────────────────────────────────────────────────────────
CREATE TABLE "agent"."agent_runs" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  -- Platform surface that started this run — mirrors agent-runner's
  -- PlatformSurface union (execute-turn.ts) so the row and the seam agree.
  "surface" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  -- Serialized RunSpec: instruction, model, option snapshot. Never engine
  -- ports/callbacks — those are constructed in-process by the worker.
  "spec" jsonb NOT NULL,
  -- Durable claim/lease (see module comment above).
  "claimed_by" text NULL,
  "lease_expires_at" timestamptz NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  -- Latest checkpoint only; append-only history lives in agent_run_events.
  "checkpoint" jsonb NULL,
  "checkpoint_seq" integer NOT NULL DEFAULT 0,
  "result" jsonb NULL,
  "error" text NULL,
  -- Set by the cancel path; the worker observes this and drops the run future
  -- (Stella-style structured cancellation, spec.md §4.2).
  "cancel_requested" boolean NOT NULL DEFAULT false,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_runs_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agent_runs_surface_check"
    CHECK (surface IN ('chat', 'api-chat', 'a2a', 'repo-edit')),
  CONSTRAINT "agent_runs_status_check"
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);

-- Broad org/workspace scan (list, dashboards).
CREATE INDEX "agent_runs_org_idx"
  ON "agent"."agent_runs" ("org_id", "workspace_id");

-- Cross-org claim UPDATE + lease sweeper (see module comment: no org_id
-- prefix — the worker pool claims across every tenant via withSystemDb).
CREATE INDEX "agent_runs_claim_idx"
  ON "agent"."agent_runs" ("status", "created_at")
  WHERE status IN ('pending', 'running');

-- ── agent.agent_run_events ────────────────────────────────────────────────────
CREATE TABLE "agent"."agent_run_events" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  -- No cross-schema/cross-table FK to agent_runs — app-enforced per CLAUDE.md
  -- storage rules (same convention as file_locks.execution_id).
  "run_id" uuid NOT NULL,
  -- App-assigned, monotonic per run starting at 1 (not serial/identity).
  "seq" integer NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_events_run_seq_uq" UNIQUE ("run_id", "seq")
);

-- Broad org/workspace scan (list, GC sweeper).
CREATE INDEX "agent_run_events_org_idx"
  ON "agent"."agent_run_events" ("org_id", "workspace_id");

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.
ALTER TABLE agent.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_runs;
CREATE POLICY tenant_isolation ON agent.agent_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_run_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_run_events;
CREATE POLICY tenant_isolation ON agent.agent_run_events
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.agent_runs TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON agent.agent_run_events TO oxagen_app';
  END IF;
END
$$;
