-- 0008: GDPR Art.17/20 privacy request tables.
--
-- privacy_export_requests: tracks Art.20 data portability requests.
-- privacy_erasure_requests: tracks Art.17 right-to-erasure requests.
-- Both tables live in the auth schema alongside users.
-- Reference: migration_archive/0033_privacy_gdpr_tables.sql
-- Idempotent: DO blocks for TYPE creation, CREATE TABLE IF NOT EXISTS.

-- ── Enum types (idempotent) ──────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'auth' AND t.typname = 'privacy_request_scope'
  ) THEN
    CREATE TYPE auth.privacy_request_scope AS ENUM ('user', 'org');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'auth' AND t.typname = 'privacy_export_status'
  ) THEN
    CREATE TYPE auth.privacy_export_status AS ENUM ('queued', 'processing', 'ready', 'failed');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'auth' AND t.typname = 'privacy_erasure_status'
  ) THEN
    CREATE TYPE auth.privacy_erasure_status AS ENUM ('queued', 'processing', 'completed', 'failed');
  END IF;
END $$;

-- ── privacy_export_requests ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth.privacy_export_requests (
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
  user_id           UUID        NOT NULL,
  org_id            UUID        NOT NULL,
  scope             auth.privacy_request_scope NOT NULL,
  status            auth.privacy_export_status NOT NULL DEFAULT 'queued',
  export_url        TEXT,
  completed_at      TIMESTAMPTZ,
  error_message     TEXT,
  PRIMARY KEY (id),
  CONSTRAINT privacy_export_status_chk CHECK (status IN ('queued','processing','ready','failed'))
);

CREATE INDEX IF NOT EXISTS privacy_export_requests_user_idx ON auth.privacy_export_requests (user_id);
CREATE INDEX IF NOT EXISTS privacy_export_requests_org_idx  ON auth.privacy_export_requests (org_id);

-- ── privacy_erasure_requests ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth.privacy_erasure_requests (
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
  user_id           UUID        NOT NULL,
  org_id            UUID        NOT NULL,
  scope             auth.privacy_request_scope NOT NULL,
  status            auth.privacy_erasure_status NOT NULL DEFAULT 'queued',
  scheduled_at      TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  error_message     TEXT,
  PRIMARY KEY (id),
  CONSTRAINT privacy_erasure_status_chk CHECK (status IN ('queued','processing','completed','failed'))
);

CREATE INDEX IF NOT EXISTS privacy_erasure_requests_user_idx ON auth.privacy_erasure_requests (user_id);
CREATE INDEX IF NOT EXISTS privacy_erasure_requests_org_idx  ON auth.privacy_erasure_requests (org_id);
