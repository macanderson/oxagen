-- Drop content.files table: never written to, always returns 404 from file.serve.
-- This table was created in baseline but asset.upload never inserts reference rows,
-- making it permanently unreachable. Dropping as dead schema.

DROP POLICY IF EXISTS "content_files_tenant_rls" ON "content"."files";
DROP TABLE IF EXISTS "content"."files" CASCADE;
