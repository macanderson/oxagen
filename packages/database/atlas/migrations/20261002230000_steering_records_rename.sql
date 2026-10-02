-- Rename context records to steering records (#4325, ADR-187).
--
-- One object has one name. The tables, the capabilities, and the permissions
-- that grant them now say "steering record" and "steering PR". Mac decided on
-- 2026-09-25 that no old name stays behind as an alias, so this migration
-- moves the stored names that grant or deny a capability as well.
--
-- 1. The four steering tables take their new names. A rename changes only
--    the catalog, so no row moves. Row-level security policies, grants, and
--    foreign keys follow the table.
-- 2. Every constraint and index on those tables takes the name the Drizzle
--    schema gives it: the old table name inside it becomes the new one. That
--    covers the primary keys, the unique and check constraints, the foreign
--    key between the record and its versions, and every index.
-- 3. iam.capability_renames records each retired capability name and the
--    name that replaced it. Audit rows keep the name they recorded, and Audit
--    reads this table to show both under the current name.
-- 4. Role grants, pending access requests, and capability denies that name a
--    retired capability move to its new name. Authorization decisions and
--    snapshots, approvals, security events, and the usage ledger are history
--    and keep the name they recorded.

-- ── 1. Tables ───────────────────────────────────────────────────────────────
ALTER TABLE agent.context_records RENAME TO steering_records;
ALTER TABLE agent.context_record_versions RENAME TO steering_record_versions;
ALTER TABLE agent.context_promotions RENAME TO steering_promotions;
ALTER TABLE agent.context_proposals RENAME TO steering_proposals;

-- ── 2. Constraints and indexes ──────────────────────────────────────────────
-- Renaming a primary key or unique constraint renames its index too, so the
-- index pass after it finds those already done.
DO $$
DECLARE
  item record;
  renamed text;
BEGIN
  FOR item IN
    SELECT c.conname AS name, c.conrelid::regclass::text AS tbl
    FROM pg_constraint c
    WHERE c.conrelid IN (
      'agent.steering_records'::regclass,
      'agent.steering_record_versions'::regclass,
      'agent.steering_promotions'::regclass,
      'agent.steering_proposals'::regclass
    )
  LOOP
    renamed := replace(replace(replace(item.name,
      'context_record', 'steering_record'),
      'context_promotion', 'steering_promotion'),
      'context_proposal', 'steering_proposal');
    IF renamed <> item.name THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', item.tbl, item.name, renamed);
    END IF;
  END LOOP;

  FOR item IN
    SELECT i.relname AS name
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid IN (
      'agent.steering_records'::regclass,
      'agent.steering_record_versions'::regclass,
      'agent.steering_promotions'::regclass,
      'agent.steering_proposals'::regclass
    )
  LOOP
    renamed := replace(replace(replace(item.name,
      'context_record', 'steering_record'),
      'context_promotion', 'steering_promotion'),
      'context_proposal', 'steering_proposal');
    IF renamed <> item.name THEN
      EXECUTE format('ALTER INDEX agent.%I RENAME TO %I', item.name, renamed);
    END IF;
  END LOOP;
END
$$;

-- ── 3. Retired capability names ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iam.capability_renames (
  retired_name text PRIMARY KEY,
  current_name text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  CONSTRAINT "capability_renames_distinct_check" CHECK (retired_name <> current_name)
);
CREATE INDEX IF NOT EXISTS capability_renames_current_idx ON iam.capability_renames (current_name);

INSERT INTO iam.capability_renames (retired_name, current_name, reason) VALUES
  ('list_context_records', 'list_steering_records', '#4325'),
  ('publish_context_record', 'publish_steering_record', '#4325'),
  ('promote_context_record', 'promote_steering_record', '#4325'),
  ('revise_context_record', 'revise_steering_record', '#4325'),
  ('open_context_pr', 'open_steering_pr', '#4325'),
  ('get_context_pr', 'get_steering_pr', '#4325'),
  ('get_context_pr_diff', 'get_steering_pr_diff', '#4325'),
  ('refresh_context_pr', 'refresh_steering_pr', '#4325'),
  ('merge_context_pr', 'merge_steering_pr', '#4325')
ON CONFLICT (retired_name) DO NOTHING;

-- A platform catalog: no organization owns a row, so it carries no tenant
-- policy (tenant-policy.manifest.ts lists only tables with org_id). The app
-- reads it and never writes it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA iam TO oxagen_app;
    GRANT SELECT ON iam.capability_renames TO oxagen_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON iam.capability_renames FROM oxagen_app;
  END IF;
END
$$;

-- ── 4. Stored grants and denies ─────────────────────────────────────────────
-- These three tables force row level security. The production connection
-- already sets app.rls_bypass, and this call makes a local run behave the same
-- way. Its scope ends with this file's transaction.
SELECT set_config('app.rls_bypass', 'on', true);

-- A role that granted both names before this ran would hold two rows for one
-- capability after it, so the old row goes when the new one is already there.
DELETE FROM iam.role_grants AS old
USING iam.capability_renames AS r, iam.role_grants AS cur
WHERE old.capability_id = r.retired_name
  AND cur.role_id = old.role_id
  AND cur.capability_id = r.current_name;

-- bootstrapOrgIAM and seed-iam-defaults.ts derive a grant's public id from
-- its role and capability: rlg_ and the first 24 hex characters of
-- sha256('<role_id>:<capability_id>'). A grant they wrote gets the id they
-- would write for the new name, so a later seed run finds it and skips it. A
-- grant a person made keeps its id.
UPDATE iam.role_grants AS g
SET capability_id = r.current_name,
    public_id = CASE
      WHEN g.public_id = 'rlg_' || substr(encode(sha256(convert_to(g.role_id::text || ':' || r.retired_name, 'UTF8')), 'hex'), 1, 24)
        THEN 'rlg_' || substr(encode(sha256(convert_to(g.role_id::text || ':' || r.current_name, 'UTF8')), 'hex'), 1, 24)
      ELSE g.public_id
    END
FROM iam.capability_renames AS r
WHERE g.capability_id = r.retired_name;

UPDATE iam.access_requests AS a
SET capability_id = r.current_name
FROM iam.capability_renames AS r
WHERE a.capability_id = r.retired_name;

UPDATE iam.emergency_denies AS d
SET capability_id = r.current_name
FROM iam.capability_renames AS r
WHERE d.capability_id = r.retired_name;
