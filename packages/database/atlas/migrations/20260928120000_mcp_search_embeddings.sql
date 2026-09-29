-- mcp.search_embeddings (M15, ADR-217): one embedding per search entry.
--
-- A search-mode MCP server ranks its entries by embedding. This table holds one
-- vector per entry, keyed by the entry's content hash and by the embedding
-- target. ADR-217 makes it the exception to ADR-194 for search entries.
--
-- target_key is 32 lowercase hex characters. It hashes the provider, the
-- endpoint, and the model together, so a new model writes new rows and never
-- reads an old model's vectors. content_hash is the entry's sha256 in 64
-- lowercase hex characters. vector holds `dimensions` Float32 values in little
-- endian order, so its length is always dimensions * 4 bytes.
--
-- A row is written once and never changed. The writer inserts with
-- ON CONFLICT DO NOTHING, so the app role gets SELECT, INSERT, and DELETE, and
-- this migration revokes UPDATE and TRUNCATE. The table is tenant-isolated like
-- every org-scoped table. The columns, index, and CHECKs match
-- packages/database/src/schema/mcp.ts.

CREATE TABLE IF NOT EXISTS mcp.search_embeddings (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  target_key text NOT NULL,
  content_hash text NOT NULL,
  dimensions integer NOT NULL,
  vector bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "search_embeddings_target_key_check" CHECK (target_key ~ '^[0-9a-f]{32}$'),
  CONSTRAINT "search_embeddings_content_hash_check" CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "search_embeddings_dimensions_check" CHECK (dimensions > 0 AND dimensions <= 4096),
  CONSTRAINT "search_embeddings_vector_length_check" CHECK (octet_length(vector) = dimensions * 4)
);
CREATE UNIQUE INDEX IF NOT EXISTS search_embeddings_ws_target_hash_uniq ON mcp.search_embeddings (workspace_id, target_key, content_hash);
ALTER TABLE mcp.search_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.search_embeddings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.search_embeddings;
DROP POLICY IF EXISTS tenant_org_wide_read ON mcp.search_embeddings;
CREATE POLICY tenant_isolation ON mcp.search_embeddings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON mcp.search_embeddings
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, DELETE ON mcp.search_embeddings TO oxagen_app;
    REVOKE UPDATE, TRUNCATE ON mcp.search_embeddings FROM oxagen_app;
  END IF;
END $$;
