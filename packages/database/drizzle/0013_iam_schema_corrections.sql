-- 0013_iam_schema_corrections.sql
--
-- OXA-1506: Schema corrections across IAM tables and workflow.
--
-- Changes:
--   1. org.roles.is_system_default       text → boolean (USING cast)
--   2. org.policies.enforced             text → boolean (USING cast)
--   3. org.access_requests.ttl_seconds   text → integer (USING cast)
--   4. workflow.playbook_step_assignments public_id prefix: 'pls_' → 'psa_'
--      (the 'pls' prefix was shared with agent.plan_steps; plan_steps keeps it)
--
-- All USING clauses are explicit so Postgres does not need an implicit cast.
-- The text columns stored 'true'/'false' string literals; the CASE in the
-- boolean USING handles both the canonical form and any deviation to empty
-- string / NULL gracefully.
--
-- Idempotent guards: each ALTER is wrapped in a DO block that checks
-- information_schema before applying, so re-running is safe.
--
-- Down migration (documented, not run automatically):
--   ALTER TABLE org.roles
--     ALTER COLUMN is_system_default TYPE text USING is_system_default::text;
--   ALTER TABLE org.policies
--     ALTER COLUMN enforced TYPE text USING enforced::text;
--   ALTER TABLE org.access_requests
--     ALTER COLUMN ttl_seconds TYPE text USING ttl_seconds::text;

------------------------------------------------------------
-- 1. org.roles.is_system_default: text → boolean
------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'org'
      AND table_name   = 'roles'
      AND column_name  = 'is_system_default'
      AND data_type    = 'text'
  ) THEN
    ALTER TABLE org.roles
      ALTER COLUMN is_system_default TYPE boolean
        USING (
          CASE is_system_default
            WHEN 'true'  THEN true
            WHEN 'false' THEN false
            ELSE false
          END
        );

    ALTER TABLE org.roles
      ALTER COLUMN is_system_default SET DEFAULT false;
  END IF;
END $$;

------------------------------------------------------------
-- 2. org.policies.enforced: text → boolean
------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'org'
      AND table_name   = 'policies'
      AND column_name  = 'enforced'
      AND data_type    = 'text'
  ) THEN
    ALTER TABLE org.policies
      ALTER COLUMN enforced TYPE boolean
        USING (
          CASE enforced
            WHEN 'true'  THEN true
            WHEN 'false' THEN false
            ELSE false
          END
        );

    ALTER TABLE org.policies
      ALTER COLUMN enforced SET DEFAULT false;
  END IF;
END $$;

------------------------------------------------------------
-- 3. org.access_requests.ttl_seconds: text → integer
------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'org'
      AND table_name   = 'access_requests'
      AND column_name  = 'ttl_seconds'
      AND data_type    = 'text'
  ) THEN
    ALTER TABLE org.access_requests
      ALTER COLUMN ttl_seconds TYPE integer
        USING ttl_seconds::integer;
  END IF;
END $$;

------------------------------------------------------------
-- 4. workflow.playbook_step_assignments: rename public_id prefix pls_ → psa_
--
-- The 'pls' prefix was shared between agent.plan_steps and
-- workflow.playbook_step_assignments.  plan_steps retains 'pls'.
-- playbook_step_assignments is corrected to 'psa'.
--
-- Only existing rows need a rename; new rows are already generated with
-- 'psa_' by the application-level idMixin after the schema change.
-- The UPDATE is a no-op on an empty table.
------------------------------------------------------------

UPDATE workflow.playbook_step_assignments
   SET public_id = 'psa_' || substr(public_id, 5)
 WHERE public_id LIKE 'pls_%';
