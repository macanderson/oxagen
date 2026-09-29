-- Operator tokens for MCP Studio (M8, #4668; mcp-studio-spec, Authentication).
--
-- mcp.operator_tokens holds each operator's OAuth token for a server whose
-- auth.mode is operator-oauth: one row per operator, per server, and per
-- environment. The tokens are envelope-encrypted with the MCP credential key.
-- credential_id is the OAuth client the server names, and deleting that
-- client deletes the tokens issued to it.
--
-- user_id has no foreign key to workspace.workspace_users. That table lives
-- on the shared plane and this one on the organization's data plane
-- (ADR-042), so the resolver checks membership when it reads a token.

CREATE TABLE IF NOT EXISTS mcp.operator_tokens (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  server text NOT NULL,
  environment text NOT NULL,
  credential_id uuid,
  client_id text NOT NULL,
  client_secret_enc bytea,
  token_endpoint text NOT NULL,
  revocation_endpoint text,
  access_token_enc bytea NOT NULL,
  refresh_token_enc bytea,
  token_kms_key_id text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  last_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "operator_tokens_credential_fk" FOREIGN KEY ("credential_id") REFERENCES "mcp"."credentials" ("id") ON DELETE CASCADE,
  CONSTRAINT "operator_tokens_status_check" CHECK (status IN ('active','needs_reauth')),
  CONSTRAINT "operator_tokens_server_check" CHECK (server ~ '^[a-z][a-z0-9_]{0,23}$'),
  CONSTRAINT "operator_tokens_environment_check" CHECK (environment ~ '^[a-z][a-z0-9_]{0,31}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_tokens_operator_server_uq ON mcp.operator_tokens (workspace_id, user_id, server, environment);
CREATE INDEX IF NOT EXISTS operator_tokens_org_idx ON mcp.operator_tokens (org_id);
CREATE INDEX IF NOT EXISTS operator_tokens_credential_idx ON mcp.operator_tokens (credential_id);

ALTER TABLE mcp.operator_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.operator_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.operator_tokens;
DROP POLICY IF EXISTS tenant_org_wide_read ON mcp.operator_tokens;
CREATE POLICY tenant_isolation ON mcp.operator_tokens
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON mcp.operator_tokens
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.operator_tokens TO oxagen_app;
  END IF;
END $$;
