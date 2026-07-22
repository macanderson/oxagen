-- Governed-run authorization foundation
-- (docs/specs/run-evidence-ingress/spec.md §"Security and retention rules",
--  02-run-attempt-foundation-plan.md Task 2).
--
-- Replaces the once-per-run unrefreshed IAM decision cache with a PINNED grant
-- ceiling plus a LIVE deny check. Four tables:
--
--   iam.authorization_snapshots         immutable — the ceiling, at admission
--   iam.authorization_deny_generations  mutable  — monotonic invalidation counter
--   iam.emergency_denies                mutable  — operator deny policy
--   iam.authorization_decisions         immutable — one row per operation
--
-- The asymmetry is the whole design: the snapshot can only ever NARROW during a
-- run. A later or replacement grant cannot revive an expired member of the
-- pinned ceiling, while a suspension, revocation, or emergency deny takes effect
-- before the next operation because the generation moved.
--
-- Deny generations are maintained by SECURITY DEFINER triggers on the five
-- tables whose mutation can narrow authority. They run with a PINNED search_path
-- and their EXECUTE privilege is revoked from PUBLIC, so the application role
-- cannot call them directly. `oxagen_app` gets SELECT ONLY on the generations
-- table: it may read the counter but can never decrement or reset it, because
-- doing so would silently revive every cached allow.
--
-- Hand-written (not `atlas migrate diff`) for the same pg_trgm fresh-replay
-- reason as every migration since 20260703150000.
--
-- Renumbered from the plan's 20260806110000: main advanced past that prefix
-- (20260806120000_spend_budgets.sql). Ordered strictly after
-- 20260813100000_run_attempt_foundation_expand.sql, which agent_runs
-- .authorization_snapshot_id points into.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. iam.authorization_snapshots — immutable pinned grant ceiling (`ras_`)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE "iam"."authorization_snapshots" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  -- A governed run always executes in one workspace, so NOT NULL here unlike
  -- iam.principals / iam.principal_role_assignments.
  "workspace_id" uuid NOT NULL,
  -- The authenticated human who delegated the run. Deliberately NOT
  -- principals.parent_user_id: that column is the agent's creator, which is not
  -- necessarily who authorized this execution.
  "initiating_principal_id" uuid NOT NULL,
  "agent_principal_id" uuid NOT NULL,
  -- The canonical human ∩ agent ceiling. Preserves assignment IDs, role IDs,
  -- conditions, resource scopes, and each assignment/grant expiry — NOT
  -- flattened into a capability allowlist, because a flattened list could be
  -- silently refreshed from later grants and would lose per-binding expiry.
  "grant_ceiling" jsonb NOT NULL,
  "grant_ceiling_digest" text NOT NULL,
  "snapshot_digest" text NOT NULL,
  -- The deny-generation vector observed at resolution. Any later value means
  -- cached allows are stale and must be re-derived.
  "org_deny_generation" bigint NOT NULL,
  "workspace_deny_generation" bigint NOT NULL,
  -- Earliest instant at which some member of the ceiling expires; NULL means
  -- nothing in the ceiling expires on a clock.
  "next_validity_boundary_at" timestamptz NULL,
  "resolved_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "authorization_snapshots_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "authorization_snapshots_generation_check"
    CHECK (org_deny_generation >= 0 AND workspace_deny_generation >= 0),
  CONSTRAINT "authorization_snapshots_digest_check"
    CHECK (grant_ceiling_digest ~ '^sha256:[0-9a-f]{64}$'
       AND snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- A delegation is between two distinct principals; a self-delegation would
  -- mean the ceiling is not actually an intersection.
  CONSTRAINT "authorization_snapshots_principals_distinct_check"
    CHECK (initiating_principal_id <> agent_principal_id)
);
CREATE INDEX "authorization_snapshots_org_idx"
  ON "iam"."authorization_snapshots" ("org_id", "workspace_id");
CREATE INDEX "authorization_snapshots_principals_idx"
  ON "iam"."authorization_snapshots" ("org_id", "initiating_principal_id", "agent_principal_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 2. iam.authorization_deny_generations — mutable monotonic counter
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE "iam"."authorization_deny_generations" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "org_id" uuid NOT NULL,
  -- NULL = the org-wide scope row.
  "workspace_id" uuid NULL,
  "scope_kind" text NOT NULL,
  "generation" bigint NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "authorization_deny_generations_scope_kind_check"
    CHECK ((scope_kind = 'org' AND workspace_id IS NULL)
        OR (scope_kind = 'workspace' AND workspace_id IS NOT NULL)),
  CONSTRAINT "authorization_deny_generations_generation_check"
    CHECK (generation >= 1)
);
-- Standard UNIQUE treats NULLs as distinct, so the org scope needs its own
-- partial index — same pattern as pra_principal_role_org_null_workspace_idx.
CREATE UNIQUE INDEX "authorization_deny_generations_org_uq"
  ON "iam"."authorization_deny_generations" ("org_id")
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX "authorization_deny_generations_workspace_uq"
  ON "iam"."authorization_deny_generations" ("org_id", "workspace_id")
  WHERE workspace_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. iam.emergency_denies — mutable operator deny policy (`emd_`)
-- ════════════════════════════════════════════════════════════════════════════
-- Typed, not free-form: a deny targets either a capability or a resource scope,
-- never both, so the live check is an index lookup rather than a policy
-- evaluation. Deactivation sets active = false and keeps the row (DELETE is
-- revoked) so the audit trail of what was denied when survives.
CREATE TABLE "iam"."emergency_denies" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  -- NULL = an org-wide deny.
  "workspace_id" uuid NULL,
  "scope_kind" text NOT NULL,
  "deny_kind" text NOT NULL,
  "capability_id" text NULL,
  "resource_scope_digest" text NULL,
  -- Optional narrowing to one principal; NULL denies for every principal in
  -- the scope.
  "principal_id" uuid NULL,
  "reason" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  "deactivated_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "emergency_denies_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "emergency_denies_scope_kind_check"
    CHECK ((scope_kind = 'org' AND workspace_id IS NULL)
        OR (scope_kind = 'workspace' AND workspace_id IS NOT NULL)),
  CONSTRAINT "emergency_denies_deny_kind_check"
    CHECK ((deny_kind = 'capability' AND capability_id IS NOT NULL AND resource_scope_digest IS NULL)
        OR (deny_kind = 'resource_scope' AND resource_scope_digest IS NOT NULL AND capability_id IS NULL)),
  CONSTRAINT "emergency_denies_active_check"
    CHECK ((active = true AND deactivated_at IS NULL)
        OR (active = false AND deactivated_at IS NOT NULL)),
  CONSTRAINT "emergency_denies_digest_check"
    CHECK (resource_scope_digest IS NULL OR resource_scope_digest ~ '^sha256:[0-9a-f]{64}$')
);
-- The live-check index: only active denies are ever scanned.
CREATE INDEX "emergency_denies_active_idx"
  ON "iam"."emergency_denies" ("org_id", "workspace_id", "deny_kind", "capability_id")
  WHERE active = true;
CREATE INDEX "emergency_denies_org_idx"
  ON "iam"."emergency_denies" ("org_id", "workspace_id");
CREATE INDEX "emergency_denies_principal_idx"
  ON "iam"."emergency_denies" ("principal_id")
  WHERE principal_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. iam.authorization_decisions — immutable decision record (`azd_`)
-- ════════════════════════════════════════════════════════════════════════════
-- One row per governed operation, for allow, deny, approval-pending, AND
-- evaluation error. The kernel creates it; a caller can never supply a decision
-- reference, and agent-run execution fails closed if the row cannot be inserted
-- — an unrecorded decision is not an allowed one.
CREATE TABLE "iam"."authorization_decisions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  -- NULL for org-scoped operations that precede a workspace selection.
  "workspace_id" uuid NULL,
  "capability_id" text NOT NULL,
  "request_id" text NOT NULL,
  "actor_principal_id" uuid NOT NULL,
  -- For a delegated agent call, the human whose ceiling was intersected.
  "on_behalf_of_principal_id" uuid NULL,
  "scope_kind" text NOT NULL,
  "resource_scope_digest" text NULL,
  -- Complete run bindings, or none — a partial binding cannot be audited back
  -- to an attempt.
  "run_id" uuid NULL,
  "attempt_id" uuid NULL,
  "authorization_snapshot_id" uuid NULL,
  -- The generation vector this decision was evaluated against. A decision read
  -- back at a higher generation is known-stale by inspection.
  "org_deny_generation" bigint NOT NULL,
  "workspace_deny_generation" bigint NULL,
  "outcome" text NOT NULL,
  "reason_code" text NULL,
  "approval_request_id" uuid NULL,
  "input_digest" text NOT NULL,
  "trace_digest" text NULL,
  "decision_digest" text NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "authorization_decisions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "authorization_decisions_outcome_check"
    CHECK (outcome IN ('allow', 'deny', 'approval_pending', 'error')),
  CONSTRAINT "authorization_decisions_scope_kind_check"
    CHECK ((scope_kind = 'org' AND workspace_id IS NULL)
        OR (scope_kind = 'workspace' AND workspace_id IS NOT NULL)),
  CONSTRAINT "authorization_decisions_run_binding_check" CHECK (
    (
      run_id IS NULL
      AND attempt_id IS NULL
      AND authorization_snapshot_id IS NULL
    ) OR (
      run_id IS NOT NULL
      AND attempt_id IS NOT NULL
      AND authorization_snapshot_id IS NOT NULL
    )
  ),
  -- A workspace-scoped decision must record the workspace generation it saw; an
  -- org-scoped one has no workspace generation to record.
  CONSTRAINT "authorization_decisions_generation_check"
    CHECK (org_deny_generation >= 0
       AND (workspace_id IS NULL) = (workspace_deny_generation IS NULL)
       AND (workspace_deny_generation IS NULL OR workspace_deny_generation >= 0)),
  -- An approval-pending outcome must name the approval it is waiting on.
  CONSTRAINT "authorization_decisions_approval_check"
    CHECK ((outcome = 'approval_pending') = (approval_request_id IS NOT NULL)),
  CONSTRAINT "authorization_decisions_digest_check"
    CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'
       AND decision_digest ~ '^sha256:[0-9a-f]{64}$'
       AND (trace_digest IS NULL OR trace_digest ~ '^sha256:[0-9a-f]{64}$')
       AND (resource_scope_digest IS NULL OR resource_scope_digest ~ '^sha256:[0-9a-f]{64}$'))
);
CREATE INDEX "authorization_decisions_org_idx"
  ON "iam"."authorization_decisions" ("org_id", "workspace_id");
-- Attempt-scoped audit read: "every decision this attempt made, in order".
CREATE INDEX "authorization_decisions_attempt_idx"
  ON "iam"."authorization_decisions" ("attempt_id", "decided_at")
  WHERE attempt_id IS NOT NULL;
CREATE INDEX "authorization_decisions_capability_outcome_idx"
  ON "iam"."authorization_decisions" ("org_id", "capability_id", "outcome", "decided_at");
CREATE INDEX "authorization_decisions_request_idx"
  ON "iam"."authorization_decisions" ("request_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Deny-generation maintenance — SECURITY DEFINER, pinned search_path
-- ════════════════════════════════════════════════════════════════════════════
-- The bump runs in the SAME transaction as the change that narrows authority,
-- so a suspension is visible to the next authorization check without any cache
-- invalidation message crossing a process boundary.
--
-- SECURITY DEFINER is required because oxagen_app has SELECT ONLY on the
-- generations table: the trigger writes with the definer's rights so the
-- application role can never reach the counter directly. search_path is PINNED
-- to pg_catalog, public — public is needed for the `citext`/`uuid` extension
-- types these tables use, and pinning it defeats search_path injection.
--
-- RLS interaction: authorization_deny_generations carries FORCE ROW LEVEL
-- SECURITY, so a non-superuser definer is itself subject to tenant_isolation.
-- That is intentional and consistent — the scope written here is always taken
-- from the row whose mutation fired the trigger, and that row was already
-- visible under the same tenant predicate (or under app.rls_bypass='on' for a
-- withSystemDb path). A superuser definer bypasses RLS outright. Either way the
-- bump lands; there is no case where the source mutation succeeds and the
-- generation silently fails to advance.
CREATE OR REPLACE FUNCTION "iam"."bump_deny_generation"(
  p_org_id uuid,
  p_workspace_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RETURN;
  END IF;

  -- Org scope. ON CONFLICT targets the partial unique index, so the row is
  -- created on first bump rather than requiring a backfill.
  INSERT INTO iam.authorization_deny_generations
    (org_id, workspace_id, scope_kind, generation, updated_at)
  VALUES (p_org_id, NULL, 'org', 1, now())
  ON CONFLICT (org_id) WHERE workspace_id IS NULL
  DO UPDATE SET
    generation = iam.authorization_deny_generations.generation + 1,
    updated_at = now();

  IF p_workspace_id IS NOT NULL THEN
    INSERT INTO iam.authorization_deny_generations
      (org_id, workspace_id, scope_kind, generation, updated_at)
    VALUES (p_org_id, p_workspace_id, 'workspace', 1, now())
    ON CONFLICT (org_id, workspace_id) WHERE workspace_id IS NOT NULL
    DO UPDATE SET
      generation = iam.authorization_deny_generations.generation + 1,
      updated_at = now();
  END IF;
END;
$$;

-- Generic AFTER trigger for the tables that carry org_id (+ optional
-- workspace_id): principals, principal_role_assignments, emergency_denies.
CREATE OR REPLACE FUNCTION "iam"."deny_generation_scoped_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row record;
BEGIN
  -- DELETE carries its scope on OLD; INSERT/UPDATE on NEW. A tenant move would
  -- narrow authority in BOTH scopes, so an UPDATE bumps whichever it can see —
  -- OLD first, then NEW when they differ.
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  PERFORM iam.bump_deny_generation(v_row.org_id, v_row.workspace_id);

  IF TG_OP = 'UPDATE'
     AND (OLD.org_id IS DISTINCT FROM NEW.org_id
          OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id) THEN
    PERFORM iam.bump_deny_generation(OLD.org_id, OLD.workspace_id);
  END IF;

  RETURN NULL;
END;
$$;

-- Org-only variant for tables with no workspace_id column (roles, role_grants).
-- A role or grant change narrows authority across every workspace in the org,
-- so bumping the org generation is both correct and sufficient: readers
-- intersect the org and workspace generations.
CREATE OR REPLACE FUNCTION "iam"."deny_generation_org_trigger"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  PERFORM iam.bump_deny_generation(v_row.org_id, NULL);

  IF TG_OP = 'UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    PERFORM iam.bump_deny_generation(OLD.org_id, NULL);
  END IF;

  RETURN NULL;
END;
$$;

-- The five mutation surfaces that can narrow authority. Principal status and
-- deletion, PRA changes, role and role-grant changes, and emergency denies.
DROP TRIGGER IF EXISTS "principals_deny_generation" ON "iam"."principals";
CREATE TRIGGER "principals_deny_generation"
  AFTER INSERT OR UPDATE OR DELETE ON "iam"."principals"
  FOR EACH ROW EXECUTE FUNCTION "iam"."deny_generation_scoped_trigger"();

DROP TRIGGER IF EXISTS "pra_deny_generation" ON "iam"."principal_role_assignments";
CREATE TRIGGER "pra_deny_generation"
  AFTER INSERT OR UPDATE OR DELETE ON "iam"."principal_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION "iam"."deny_generation_scoped_trigger"();

DROP TRIGGER IF EXISTS "emergency_denies_deny_generation" ON "iam"."emergency_denies";
CREATE TRIGGER "emergency_denies_deny_generation"
  AFTER INSERT OR UPDATE OR DELETE ON "iam"."emergency_denies"
  FOR EACH ROW EXECUTE FUNCTION "iam"."deny_generation_scoped_trigger"();

DROP TRIGGER IF EXISTS "roles_deny_generation" ON "iam"."roles";
CREATE TRIGGER "roles_deny_generation"
  AFTER INSERT OR UPDATE OR DELETE ON "iam"."roles"
  FOR EACH ROW EXECUTE FUNCTION "iam"."deny_generation_org_trigger"();

DROP TRIGGER IF EXISTS "role_grants_deny_generation" ON "iam"."role_grants";
CREATE TRIGGER "role_grants_deny_generation"
  AFTER INSERT OR UPDATE OR DELETE ON "iam"."role_grants"
  FOR EACH ROW EXECUTE FUNCTION "iam"."deny_generation_org_trigger"();

-- A SECURITY DEFINER function is executable by PUBLIC unless revoked. Without
-- this, any role could call bump_deny_generation() directly and invalidate an
-- arbitrary tenant's cached allows (a denial-of-service on authorization).
REVOKE ALL ON FUNCTION "iam"."bump_deny_generation"(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION "iam"."deny_generation_scoped_trigger"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "iam"."deny_generation_org_trigger"() FROM PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. RLS
-- ════════════════════════════════════════════════════════════════════════════
-- authorization_snapshots is `standard` (org_id + workspace_id NOT NULL). The
-- other three are `workspace_nullable`: a NULL workspace_id row is org-wide and
-- visible to every workspace in the org, matching iam.principals.

ALTER TABLE iam.authorization_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.authorization_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.authorization_snapshots;
CREATE POLICY tenant_isolation ON iam.authorization_snapshots
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE iam.authorization_deny_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.authorization_deny_generations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.authorization_deny_generations;
CREATE POLICY tenant_isolation ON iam.authorization_deny_generations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

ALTER TABLE iam.emergency_denies ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.emergency_denies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.emergency_denies;
CREATE POLICY tenant_isolation ON iam.emergency_denies
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

ALTER TABLE iam.authorization_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.authorization_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.authorization_decisions;
CREATE POLICY tenant_isolation ON iam.authorization_decisions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

-- ════════════════════════════════════════════════════════════════════════════
-- 7. oxagen_app privileges
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    -- Immutable: SELECT + INSERT only.
    EXECUTE 'GRANT SELECT, INSERT ON iam.authorization_snapshots TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON iam.authorization_decisions TO oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON iam.authorization_snapshots FROM oxagen_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON iam.authorization_decisions FROM oxagen_app';

    -- Operator deny policy is mutable (activate/deactivate) but never deleted:
    -- a removed deny row would erase the record of what was blocked and when.
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON iam.emergency_denies TO oxagen_app';
    EXECUTE 'REVOKE DELETE ON iam.emergency_denies FROM oxagen_app';

    -- SELECT ONLY. The application role reads the generation to detect stale
    -- allows; it must never be able to decrement or reset one, which would
    -- silently revive every cached allow. The SECURITY DEFINER triggers above
    -- are the only writers.
    EXECUTE 'GRANT SELECT ON iam.authorization_deny_generations TO oxagen_app';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON iam.authorization_deny_generations FROM oxagen_app';
  END IF;
END
$$;
