-- forge.revision_certifications (ADR-294): the witness's queue. One row per
-- revision whose diff is stored. A row starts pending, and the witness
-- (ADR-064) later decides whether the change meets its definition of done:
-- certified or rejected, with the time it decided and its verdict. The pull
-- request's runs, work orders, and issues reach a row through the forge link
-- tables.

CREATE TABLE IF NOT EXISTS forge.revision_certifications (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  pull_request_id uuid NOT NULL REFERENCES forge.pull_requests (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES forge.pull_request_revisions (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  verdict jsonb,
  CONSTRAINT "revision_certifications_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "revision_certifications_state_check" CHECK (state IN ('pending','certified','rejected')),
  CONSTRAINT "revision_certifications_decided_check" CHECK ((state = 'pending') = (decided_at IS NULL) AND (state <> 'pending' OR verdict IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS revision_certifications_revision_uq ON forge.revision_certifications (revision_id);
-- The witness reads its queue oldest first, per workspace and state.
CREATE INDEX IF NOT EXISTS revision_certifications_queue_idx ON forge.revision_certifications (org_id, workspace_id, state, requested_at);

COMMENT ON TABLE forge.revision_certifications IS
  'The witness''s queue: one row per revision whose diff is stored, pending until the witness decides (ADR-294).';
COMMENT ON COLUMN forge.revision_certifications.state IS
  'pending (no verdict yet), certified (the change meets its definition of done), or rejected (it does not).';

ALTER TABLE forge.revision_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE forge.revision_certifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON forge.revision_certifications;
DROP POLICY IF EXISTS tenant_org_wide_read ON forge.revision_certifications;
CREATE POLICY tenant_isolation ON forge.revision_certifications
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON forge.revision_certifications
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON forge.revision_certifications TO oxagen_app;
  END IF;
END $$;

-- Queue every revision whose diff was stored before this table existed, so the
-- witness starts from a complete queue. Its requested time is when the diff was
-- captured. The public id takes the form the app's `rcf_` ids take: 22
-- lower-case characters, here from a random uuid's hex digits.
INSERT INTO forge.revision_certifications (public_id, org_id, workspace_id, pull_request_id, revision_id, requested_at)
SELECT
  'rcf_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
  r.org_id,
  r.workspace_id,
  r.pull_request_id,
  r.id,
  r.captured_at
FROM forge.pull_request_revisions r
WHERE r.diff_status = 'stored'
ON CONFLICT (revision_id) DO NOTHING;
