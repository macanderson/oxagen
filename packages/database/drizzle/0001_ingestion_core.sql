-- 0001_ingestion_core.sql
-- Ingestion pipeline foundation: connection registry, encrypted credentials,
-- OAuth tokens, and webhook subscription tracking.
-- Credentials live in Postgres (encrypted). All ingested entity nodes live
-- 100% in Neo4j — no entity data rows here.

CREATE SCHEMA IF NOT EXISTS ingestion;

-- ── ingestion.source_connections ────────────────────────────────────────────
-- One row per workspace data-source connection. Holds metadata and delivery
-- config only — credentials are in ingestion.auth_credentials.

CREATE TABLE ingestion.source_connections (
  id                UUID        NOT NULL DEFAULT COALESCE(
                                  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                    THEN uuid_generate_v7()
                                    ELSE uuid_generate_v4()
                                  END,
                                  uuid_generate_v4()
                                ),
  public_id         CITEXT      NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workspace_id      UUID        NOT NULL,
  org_id            UUID        NOT NULL,
  -- Open string slug: "github", "google-drive", "zoom", "snowflake", etc.
  -- Not a foreign key — connectors are registered in code, not a DB table.
  connector_id      TEXT        NOT NULL,
  display_name      TEXT        NOT NULL,
  -- Auth pattern discriminant — matches ingestion.auth_credentials.auth_scheme.
  -- Values: "oauth2" | "api_key" | "api_key_secret" | "bearer_token" |
  --         "basic_auth" | "connection_string" | "service_account_json" |
  --         "aws_cross_account_role" | "aws_iam_keys" | "ssh_private_key" |
  --         "rsa_key_pair" | "tls_mutual" | "public"
  auth_scheme       TEXT        NOT NULL,
  -- How data is delivered into the pipeline.
  -- Values: "webhook" | "rest_polling" | "graphql_polling" | "sql_query" |
  --         "nosql_query" | "file_source" | "kafka" | "pubsub" | "eventbridge" | "cdc"
  delivery_method   TEXT        NOT NULL,
  -- Delivery-specific config: poll_interval_seconds, query, bucket_name, etc.
  delivery_config   JSONB,
  -- pending_setup | active | paused | needs_reauth | error | deleting | reconfiguring | deleted
  status            TEXT        NOT NULL DEFAULT 'pending_setup',
  -- Materialized entity count incremented by the ingestion pipeline on each write.
  -- Used for fast display in the UI; exact count is Neo4j authoritative.
  entity_count      INTEGER     NOT NULL DEFAULT 0,
  -- Per-record-type sync cursor: { "pull_request": "2026-01-01T00:00:00Z", ... }
  cursor            JSONB,
  last_sync_at      TIMESTAMPTZ,
  error_message     TEXT,
  deleted_at        TIMESTAMPTZ,
  deleted_by        UUID,
  PRIMARY KEY (id),
  CONSTRAINT source_connections_status_chk CHECK (status IN (
    'pending_setup','active','paused','needs_reauth','error','deleting','reconfiguring','deleted'
  ))
);

CREATE INDEX source_connections_workspace_org_idx ON ingestion.source_connections (workspace_id, org_id);
CREATE INDEX source_connections_connector_idx      ON ingestion.source_connections (connector_id);
CREATE INDEX source_connections_status_idx         ON ingestion.source_connections (status) WHERE deleted_at IS NULL;
CREATE INDEX source_connections_deleted_at_idx     ON ingestion.source_connections (deleted_at) WHERE deleted_at IS NOT NULL;

-- ── ingestion.auth_credentials ───────────────────────────────────────────────
-- Encrypted credential payload for each connection. Never joined in application
-- queries unless actively establishing or refreshing a connection.
-- encrypted_payload schema: { keyVersion, iv, ciphertext, tag } (AES-256-GCM).
-- keyVersion: "env:v1" today; KMS key ARN when AWS KMS is provisioned.

CREATE TABLE ingestion.auth_credentials (
  connection_id     UUID        NOT NULL,
  -- Mirrors source_connections.auth_scheme for routing the decrypt path.
  auth_scheme       TEXT        NOT NULL,
  -- AES-256-GCM encrypted JSON blob of the credential. Schema:
  --   { keyVersion: string, iv: string, ciphertext: string, tag: string }
  encrypted_payload JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (connection_id),
  CONSTRAINT auth_credentials_connection_fk
    FOREIGN KEY (connection_id) REFERENCES ingestion.source_connections(id) ON DELETE CASCADE
);

-- ── ingestion.oauth_tokens ───────────────────────────────────────────────────
-- Short-lived OAuth tokens stored separately from auth_credentials so the
-- proactive-refresh Inngest job can update them without loading the full
-- credential payload. All token values are AES-256-GCM encrypted.

CREATE TABLE ingestion.oauth_tokens (
  connection_id           UUID        NOT NULL,
  -- { keyVersion, iv, ciphertext, tag }
  access_token_enc        JSONB       NOT NULL,
  -- null for client_credentials flow (no refresh token issued)
  refresh_token_enc       JSONB,
  expires_at              TIMESTAMPTZ,
  token_type              TEXT        NOT NULL DEFAULT 'Bearer',
  scopes                  TEXT[]      NOT NULL DEFAULT '{}',
  -- User's ID within the OAuth provider (GitHub user id, Google sub, etc.)
  provider_user_id        TEXT,
  -- Org/team ID within the provider (GitHub org, Slack workspace, etc.)
  provider_account_id     TEXT,
  last_refreshed_at       TIMESTAMPTZ,
  -- Consecutive refresh failures. 3+ → source_connections.status = needs_reauth.
  refresh_failure_count   INTEGER     NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (connection_id),
  CONSTRAINT oauth_tokens_connection_fk
    FOREIGN KEY (connection_id) REFERENCES ingestion.source_connections(id) ON DELETE CASCADE
);

CREATE INDEX oauth_tokens_expires_at_idx ON ingestion.oauth_tokens (expires_at)
  WHERE expires_at IS NOT NULL;

-- ── ingestion.webhook_subscriptions ─────────────────────────────────────────
-- Tracks webhook subscriptions registered with the source system after a
-- connection is activated. One connection can have multiple subscriptions
-- (e.g. one per record type). The HMAC secret is encrypted at rest.

CREATE TABLE ingestion.webhook_subscriptions (
  id                        UUID        NOT NULL DEFAULT COALESCE(
                                          CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                            THEN uuid_generate_v7()
                                            ELSE uuid_generate_v4()
                                          END,
                                          uuid_generate_v4()
                                        ),
  public_id                 CITEXT      NOT NULL UNIQUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  connection_id             UUID        NOT NULL,
  -- Stable inbound path: /api/v1/webhooks/{connectorId}/{connectionId}
  webhook_path              TEXT        NOT NULL UNIQUE,
  -- Encrypted HMAC signing secret: { keyVersion, iv, ciphertext, tag }
  secret_enc                JSONB,
  -- e.g. 'sha256' | 'sha1' | 'sha512'
  hmac_algorithm            TEXT,
  -- e.g. 'X-Hub-Signature-256' | 'Stripe-Signature' | 'Linear-Signature'
  hmac_header               TEXT,
  -- The subscription ID as returned by the source system's API
  provider_subscription_id  TEXT,
  -- Which source record types this subscription covers
  record_types              TEXT[]      NOT NULL DEFAULT '{}',
  -- active | expired | failed
  status                    TEXT        NOT NULL DEFAULT 'active',
  last_received_at          TIMESTAMPTZ,
  PRIMARY KEY (id),
  CONSTRAINT webhook_subscriptions_connection_fk
    FOREIGN KEY (connection_id) REFERENCES ingestion.source_connections(id) ON DELETE CASCADE,
  CONSTRAINT webhook_subscriptions_status_chk
    CHECK (status IN ('active','expired','failed'))
);

CREATE INDEX webhook_subscriptions_connection_idx ON ingestion.webhook_subscriptions (connection_id);
CREATE INDEX webhook_subscriptions_status_idx      ON ingestion.webhook_subscriptions (status);
