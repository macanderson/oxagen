-- Add the missing updated_by_user_id audit column to mcp.catalog_servers.
--
-- 20260625130000_catalog_servers.sql created the table with created_at,
-- updated_at and created_by_user_id but OMITTED updated_by_user_id, while the
-- Drizzle schema's auditMixin() (packages/database/src/schema/_mixins.ts) and
-- the mcpCatalogServers table (packages/database/src/schema/mcp.ts) both define
-- it. Any insert/update that sets updatedByUserId therefore fails with:
--   column "updated_by_user_id" of relation "catalog_servers" does not exist
-- Nullable, no default — matches created_by_user_id and the auditMixin shape.
ALTER TABLE mcp.catalog_servers
  ADD COLUMN IF NOT EXISTS updated_by_user_id UUID;
