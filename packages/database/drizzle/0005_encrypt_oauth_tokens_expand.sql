-- OXA-1420: Encrypt OAuth tokens at rest — EXPAND phase.
--
-- This is a forward-only, additive (EXPAND) migration following the
-- expand-then-contract pattern (spec Policy 5).  It adds:
--
--   auth.accounts.access_token_enc   bytea  — AES-256-GCM envelope-encrypted
--   auth.accounts.refresh_token_enc  bytea  — AES-256-GCM envelope-encrypted
--   auth.accounts.id_token_enc       bytea  — AES-256-GCM envelope-encrypted
--   auth.accounts.token_kms_key_id   text   — CMK id used to wrap the row DEK
--
-- The plaintext columns (access_token, refresh_token, id_token) are NOT
-- dropped here.  They remain nullable and are kept during the transition
-- window so that:
--   (a) existing rows continue to be readable before backfill;
--   (b) a partial deploy does not brick sessions in flight.
--
-- DROP of the plaintext columns is the CONTRACT migration, tracked as a
-- separate follow-up ticket.  Do NOT add a DROP in this file.
--
-- Safe to run multiple times (IF NOT EXISTS guards on columns).

DO $$
BEGIN
  -- access_token_enc
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth'
      AND table_name   = 'accounts'
      AND column_name  = 'access_token_enc'
  ) THEN
    ALTER TABLE "auth"."accounts"
      ADD COLUMN "access_token_enc" bytea;
  END IF;

  -- refresh_token_enc
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth'
      AND table_name   = 'accounts'
      AND column_name  = 'refresh_token_enc'
  ) THEN
    ALTER TABLE "auth"."accounts"
      ADD COLUMN "refresh_token_enc" bytea;
  END IF;

  -- id_token_enc
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth'
      AND table_name   = 'accounts'
      AND column_name  = 'id_token_enc'
  ) THEN
    ALTER TABLE "auth"."accounts"
      ADD COLUMN "id_token_enc" bytea;
  END IF;

  -- token_kms_key_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth'
      AND table_name   = 'accounts'
      AND column_name  = 'token_kms_key_id'
  ) THEN
    ALTER TABLE "auth"."accounts"
      ADD COLUMN "token_kms_key_id" text;
  END IF;
END $$;

-- Explicit comment for auditors / SOC 2 reviewers.
COMMENT ON COLUMN "auth"."accounts"."access_token_enc"  IS 'AES-256-GCM envelope-encrypted OAuth access token (OXA-1420). Plaintext column retained until CONTRACT migration.';
COMMENT ON COLUMN "auth"."accounts"."refresh_token_enc" IS 'AES-256-GCM envelope-encrypted OAuth refresh token (OXA-1420). Plaintext column retained until CONTRACT migration.';
COMMENT ON COLUMN "auth"."accounts"."id_token_enc"      IS 'AES-256-GCM envelope-encrypted OIDC id_token (OXA-1420). Plaintext column retained until CONTRACT migration.';
COMMENT ON COLUMN "auth"."accounts"."token_kms_key_id"  IS 'KMS CMK id / ARN used to wrap the data encryption key for this row (OXA-1420).';
