-- Relays for servers and APIs in a private network (M12, #4685;
-- mcp-studio-spec, Network paths).
--
-- mcp.relays holds one row per relay a workspace registered. A relay
-- authenticates to the broker with a relay token, and this table keeps only
-- the token's SHA-256 in lowercase hex. The plaintext token is shown once, when
-- create_relay mints it.
--
-- The broker looks a token up by its hash before any organization is known,
-- so the verifier reads this table through withSystemDb on the shared plane.
-- The tenant policy below is the backstop for any other reader.
--
-- workspace_public_id is copied from workspace.workspaces when the relay is
-- created, so the verifier returns the wrk_ id an envelope names without a
-- join.
--
-- A name is unique among the live relays of a workspace. revoke_relay sets
-- revoked_at, and the name is free again once the old row is revoked.

CREATE TABLE IF NOT EXISTS mcp.relays (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id public.citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  workspace_public_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid NOT NULL,
  revoked_at timestamptz,
  revoked_by_id uuid,
  CONSTRAINT "relays_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "relays_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "relays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "relays_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspace"."workspaces" ("id") ON DELETE CASCADE,
  CONSTRAINT "relays_name_check" CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT "relays_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "relays_revoked_by_check" CHECK (revoked_at IS NOT NULL OR revoked_by_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS relays_workspace_name_live_uq ON mcp.relays (org_id, workspace_id, name) WHERE (revoked_at IS NULL);
CREATE INDEX IF NOT EXISTS relays_workspace_idx ON mcp.relays (org_id, workspace_id);

ALTER TABLE mcp.relays ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.relays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.relays;
DROP POLICY IF EXISTS tenant_org_wide_read ON mcp.relays;
CREATE POLICY tenant_isolation ON mcp.relays
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON mcp.relays
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.relays TO oxagen_app;
  END IF;
END $$;
