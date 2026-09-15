-- ADR-062 (G2963): the findings job's output.
--
-- Written against the drizzle schema (packages/database/src/schema/cost.ts,
-- `findings`) in the shape `atlas migrate diff` emits for the cost tables.
--
-- cost.findings: one open row per (workspace, kind, subject) the detectors see
-- in the trailing window, replaced on every pass (the partial unique index is
-- the upsert target); a row a person applied or dismissed keeps the decision
-- and is never rewritten. Money is integer micro-USD: the saving is measured
-- minus counterfactual over the cited runs, at the price each call paid, and
-- a finding that cites no run is refused by the table.
--
-- RLS is in 20260915201100_rls_cost_findings.sql (generated from the tenant
-- policy manifest).

-- Create "findings" table
CREATE TABLE "cost"."findings" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "level" text NOT NULL,
  "subject" text NOT NULL,
  "fingerprint" text NOT NULL,
  "window_start" timestamptz NOT NULL,
  "window_end" timestamptz NOT NULL,
  "estimated_saving_micros" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "saving_basis" text NOT NULL,
  "confidence" text NOT NULL,
  "why" text NOT NULL,
  "fix" text NOT NULL,
  "cited_runs" text[] NOT NULL,
  "cited_frames" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "detected_at" timestamptz NOT NULL,
  "decided_at" timestamptz NULL,
  "decided_by_user_id" uuid NULL,
  "applied_action_id" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "findings_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "findings_basis_check" CHECK (saving_basis = ANY (ARRAY['gateway_observed'::text, 'client_attested'::text, 'mixed'::text, 'estimated'::text])),
  CONSTRAINT "findings_cited_check" CHECK (cardinality(cited_runs) > 0),
  CONSTRAINT "findings_confidence_check" CHECK (confidence = ANY (ARRAY['high'::text, 'medium'::text])),
  CONSTRAINT "findings_decision_check" CHECK (((status = 'open'::text) = (decided_at IS NULL)) AND ((status = 'applied'::text) = (applied_action_id IS NOT NULL))),
  CONSTRAINT "findings_kind_check" CHECK (kind = ANY (ARRAY['cache_writes_never_read'::text, 'duplicate_tool_calls'::text, 'repeated_shell_commands'::text, 'unpaged_results'::text])),
  CONSTRAINT "findings_level_check" CHECK (level = ANY (ARRAY['tool'::text, 'agent'::text, 'operator'::text, 'workspace'::text])),
  CONSTRAINT "findings_saving_check" CHECK (estimated_saving_micros > 0),
  CONSTRAINT "findings_status_check" CHECK (status = ANY (ARRAY['open'::text, 'applied'::text, 'dismissed'::text])),
  CONSTRAINT "findings_window_check" CHECK (window_end > window_start)
);
-- Create index "findings_open_fingerprint_idx" to table: "findings"
CREATE UNIQUE INDEX "findings_open_fingerprint_idx" ON "cost"."findings" ("workspace_id", "fingerprint") WHERE (status = 'open'::text);
-- Create index "findings_workspace_status_idx" to table: "findings"
CREATE INDEX "findings_workspace_status_idx" ON "cost"."findings" ("workspace_id", "status", "estimated_saving_micros");

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The default privileges 20260915020000 set on the cost schema cover a table
-- created later by the same role; the explicit grant covers an environment
-- whose migrations ran as another role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON cost.findings TO oxagen_app';
  END IF;
END
$$;
