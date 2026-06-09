-- 0004_ingestion_oauth_accounts.sql
-- Introduces ingestion.oauth_accounts so a single OAuth provider account
-- (one Google user, one GitHub user, etc.) can be shared across multiple
-- source_connections without duplicating tokens.
--
-- Design: one oauth_accounts row per provider+provider_user_id pair per org.
-- Multiple source_connections reference the same oauth_account_id.
-- Token refresh updates one row; all child connections benefit automatically.

-- ── ingestion.oauth_accounts ─────────────────────────────────────────────────

CREATE TABLE ingestion.oauth_accounts (
  id                      UUID        NOT NULL DEFAULT COALESCE(
                                        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                          THEN uuid_generate_v7()
                                          ELSE uuid_generate_v4()
                                        END,
                                        uuid_generate_v4()
                                      ),
  public_id               CITEXT      NOT NULL UNIQUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id                  UUID        NOT NULL,
  -- OAuth provider slug: "google" | "github" | "slack" | "salesforce" | etc.
  provider                TEXT        NOT NULL,
  -- The account's stable ID within the provider (Google sub, GitHub user id, etc.)
  provider_user_id        TEXT        NOT NULL,
  -- Human-readable identifier — email, GitHub username, Slack display name, etc.
  provider_user_email     TEXT,
  provider_user_name      TEXT,
  -- Encrypted access token: { keyVersion, iv, ciphertext, tag } (AES-256-GCM)
  access_token_enc        JSONB       NOT NULL,
  -- Null for client_credentials flows (no refresh token issued)
  refresh_token_enc       JSONB,
  expires_at              TIMESTAMPTZ,
  token_type              TEXT        NOT NULL DEFAULT 'Bearer',
  scopes                  TEXT[]      NOT NULL DEFAULT '{}',
  last_refreshed_at       TIMESTAMPTZ,
  -- Consecutive refresh failures. 3+ triggers needs_reauth on all child connections.
  refresh_failure_count   INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  -- One account row per provider+user per org — prevents duplicate OAuth rows
  -- when the same provider account is connected multiple times.
  CONSTRAINT oauth_accounts_org_provider_user_uq
    UNIQUE (org_id, provider, provider_user_id)
);

CREATE INDEX oauth_accounts_org_provider_idx  ON ingestion.oauth_accounts (org_id, provider);
CREATE INDEX oauth_accounts_expires_at_idx    ON ingestion.oauth_accounts (expires_at)
  WHERE expires_at IS NOT NULL;

-- ── ingestion.source_connections — add oauth_account_id FK ──────────────────
-- Nullable: connections that use api_key / basic_auth / etc. have no oauth account.

ALTER TABLE ingestion.source_connections
  ADD COLUMN oauth_account_id UUID REFERENCES ingestion.oauth_accounts(id) ON DELETE SET NULL;

CREATE INDEX source_connections_oauth_account_idx
  ON ingestion.source_connections (oauth_account_id)
  WHERE oauth_account_id IS NOT NULL;
