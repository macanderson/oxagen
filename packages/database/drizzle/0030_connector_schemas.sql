-- Create connector_schemas table for caching YAML plugin schemas
CREATE TABLE ingestion.connector_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  plugin_id text NOT NULL,
  schema_url text,
  schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version text NOT NULL,
  plugin_version text NOT NULL,
  cached_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one schema per plugin version
CREATE UNIQUE INDEX connector_schemas_plugin_version_uniq
  ON ingestion.connector_schemas(plugin_id, plugin_version);

-- Index for lookups by plugin ID
CREATE INDEX connector_schemas_plugin_id_idx
  ON ingestion.connector_schemas(plugin_id);

-- Index for cache cleanup queries
CREATE INDEX connector_schemas_cached_at_idx
  ON ingestion.connector_schemas(cached_at);
