-- 0007_installable_plugins.sql
-- Installable plugins foundation: registries, catalog, org governance,
-- workspace install link, encrypted credentials, notifications.
-- Forward migration (immutable after merge). See spec
-- docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md §4.

CREATE SCHEMA IF NOT EXISTS mcp;
CREATE SCHEMA IF NOT EXISTS plugin;
CREATE SCHEMA IF NOT EXISTS notification;

-- ---------------------------------------------------------------------------
-- mcp.registries
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.registries (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid,
  name               text NOT NULL,
  base_url           text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  is_default_seed    boolean NOT NULL DEFAULT false,
  last_synced_at     timestamptz,
  last_synced_cursor text
);
CREATE INDEX registries_org_idx ON mcp.registries (org_id);
CREATE UNIQUE INDEX registries_org_baseurl_uniq
  ON mcp.registries (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), base_url);

-- ---------------------------------------------------------------------------
-- mcp.catalog_servers
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.catalog_servers (
  id                  uuid PRIMARY KEY DEFAULT COALESCE(
                        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                        uuid_generate_v4()),
  public_id           citext NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid,
  updated_by_user_id  uuid,
  registry_id         uuid NOT NULL REFERENCES mcp.registries(id) ON DELETE CASCADE,
  name                text NOT NULL,
  version             text NOT NULL,
  is_latest           boolean NOT NULL DEFAULT false,
  title               text,
  description         text NOT NULL,
  repository          jsonb,
  website_url         text,
  icons               jsonb NOT NULL DEFAULT '[]'::jsonb,
  packages            jsonb NOT NULL DEFAULT '[]'::jsonb,
  remotes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  transport_types     text[] NOT NULL DEFAULT '{}'::text[],
  auth_kind           text NOT NULL,
  categories          text[] NOT NULL DEFAULT '{}'::text[],
  readme_html         text,
  readme_fetched_at   timestamptz,
  status              text NOT NULL,
  published_at        timestamptz,
  upstream_updated_at timestamptz,
  status_changed_at   timestamptz,
  meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT catalog_servers_status_chk CHECK (status IN ('active','deprecated','deleted')),
  CONSTRAINT catalog_servers_auth_kind_chk CHECK (auth_kind IN ('oauth','secret','none'))
);
CREATE UNIQUE INDEX catalog_servers_name_version_uniq ON mcp.catalog_servers (registry_id, name, version);
CREATE INDEX catalog_servers_registry_name_idx ON mcp.catalog_servers (registry_id, name);
CREATE INDEX catalog_servers_categories_gin ON mcp.catalog_servers USING gin (categories);
CREATE INDEX catalog_servers_transport_gin ON mcp.catalog_servers USING gin (transport_types);

-- ---------------------------------------------------------------------------
-- plugin.org_listings
-- ---------------------------------------------------------------------------
CREATE TABLE plugin.org_listings (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  org_id             uuid NOT NULL,
  plugin_type        text NOT NULL,
  catalog_server_id  uuid REFERENCES mcp.catalog_servers(id) ON DELETE SET NULL,
  source             text NOT NULL,
  name               text NOT NULL,
  title              text,
  description        text,
  icon_url           text,
  endpoint_url       text,
  transport          text,
  auth_kind          text NOT NULL,
  auth_config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled            boolean NOT NULL DEFAULT false,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT org_listings_type_chk CHECK (plugin_type IN ('mcp_server','integration','content_tool')),
  CONSTRAINT org_listings_source_chk CHECK (source IN ('registry','custom')),
  CONSTRAINT org_listings_auth_kind_chk CHECK (auth_kind IN ('oauth','secret','none'))
);
CREATE UNIQUE INDEX org_listings_org_type_name_uniq ON plugin.org_listings (org_id, plugin_type, name);
CREATE INDEX org_listings_org_type_idx ON plugin.org_listings (org_id, plugin_type);

-- ---------------------------------------------------------------------------
-- plugin.org_denylist
-- ---------------------------------------------------------------------------
CREATE TABLE plugin.org_denylist (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  plugin_type        text NOT NULL,
  server_name        text NOT NULL,
  reason             text,
  CONSTRAINT org_denylist_type_chk CHECK (plugin_type IN ('mcp_server','integration','content_tool'))
);
CREATE UNIQUE INDEX org_denylist_org_type_name_uniq ON plugin.org_denylist (org_id, plugin_type, server_name);

-- ---------------------------------------------------------------------------
-- mcp.credentials  (SOC2 encrypted)
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.credentials (
  id                      uuid PRIMARY KEY DEFAULT COALESCE(
                            CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                              THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                            uuid_generate_v4()),
  public_id               citext NOT NULL UNIQUE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by_user_id      uuid,
  updated_by_user_id      uuid,
  org_id                  uuid NOT NULL,
  workspace_id            uuid NOT NULL,
  org_listing_id          uuid NOT NULL REFERENCES plugin.org_listings(id) ON DELETE CASCADE,
  auth_kind               text NOT NULL,
  access_token_enc        bytea,
  refresh_token_enc       bytea,
  secret_enc              bytea,
  oauth_client_secret_enc bytea,
  token_kms_key_id        text,
  oauth_client_id         text,
  scopes                  text[] NOT NULL DEFAULT '{}'::text[],
  expires_at              timestamptz,
  status                  text NOT NULL DEFAULT 'active',
  last_refreshed_at       timestamptz,
  CONSTRAINT credentials_auth_kind_chk CHECK (auth_kind IN ('oauth','secret')),
  CONSTRAINT credentials_status_chk CHECK (status IN ('active','needs_reauth','revoked'))
);
CREATE UNIQUE INDEX credentials_workspace_listing_uniq ON mcp.credentials (workspace_id, org_listing_id);
CREATE INDEX credentials_org_idx ON mcp.credentials (org_id);

-- ---------------------------------------------------------------------------
-- agent.mcp_servers — add org_listing_id link
-- ---------------------------------------------------------------------------
ALTER TABLE agent.mcp_servers ADD COLUMN org_listing_id uuid REFERENCES plugin.org_listings(id) ON DELETE CASCADE;
CREATE INDEX mcp_servers_org_listing_idx ON agent.mcp_servers (org_listing_id);

-- ---------------------------------------------------------------------------
-- notification.notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notification.notifications (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  workspace_id       uuid,
  user_id            uuid NOT NULL,
  kind               text NOT NULL,
  title              text NOT NULL,
  body               text,
  deep_link          text,
  unread             boolean NOT NULL DEFAULT true,
  archived           boolean NOT NULL DEFAULT false,
  emailed_at         timestamptz,
  CONSTRAINT notifications_kind_chk CHECK (kind IN ('system','approval','run','member','security'))
);
CREATE INDEX notifications_user_unread_idx ON notification.notifications (user_id, unread);
CREATE INDEX notifications_org_idx ON notification.notifications (org_id);

-- ---------------------------------------------------------------------------
-- Seed: the official public MCP registry, enabled by default for every org
-- (org_id NULL ⇒ global default seed).
-- ---------------------------------------------------------------------------
INSERT INTO mcp.registries (public_id, org_id, name, base_url, enabled, is_default_seed)
VALUES (
  'mreg_officialmcpregistryseed',
  NULL,
  'Official MCP Registry',
  'https://registry.modelcontextprotocol.io',
  true,
  true
);
