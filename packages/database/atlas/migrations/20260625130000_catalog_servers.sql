-- Add mcp.catalog_servers table for locally-synced registry entries.
-- Enables instant marketplace browse without a live fetch to the upstream registry.
-- Also adds sync tracking columns to mcp.registries for incremental sync.

-- ── Sync columns on registries ────────────────────────────────────────────────
ALTER TABLE mcp.registries
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_synced_cursor TEXT;

-- ── catalog_servers table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mcp.catalog_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id CITEXT NOT NULL DEFAULT ('mcat_' || substr(md5(random()::text || clock_timestamp()::text), 1, 22)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID,

  registry_id UUID NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  is_latest BOOLEAN NOT NULL DEFAULT false,
  title TEXT,
  description TEXT NOT NULL,
  icons JSONB NOT NULL DEFAULT '[]'::jsonb,
  packages JSONB NOT NULL DEFAULT '[]'::jsonb,
  remotes JSONB NOT NULL DEFAULT '[]'::jsonb,
  transport_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  auth_kind TEXT NOT NULL DEFAULT 'none',
  repository_url TEXT,
  website_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  published_at TIMESTAMPTZ,
  upstream_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique: one row per (registry, server name, version).
CREATE UNIQUE INDEX IF NOT EXISTS catalog_servers_registry_name_version_uniq
  ON mcp.catalog_servers (registry_id, name, version);

-- Browse query: latest entries for a registry, ordered by name.
CREATE INDEX IF NOT EXISTS catalog_servers_browse_idx
  ON mcp.catalog_servers (registry_id, is_latest, name);

-- Full-text search: trigram index on name, title, description for ILIKE queries.
-- Requires pg_trgm extension (already enabled in the base migration).
CREATE INDEX IF NOT EXISTS catalog_servers_search_trgm_idx
  ON mcp.catalog_servers USING gin (
    (coalesce(name, '') || ' ' || coalesce(title, '') || ' ' || coalesce(description, '')) gin_trgm_ops
  );
