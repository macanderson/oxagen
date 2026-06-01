-- 0012_auth_contract_drop_plaintext_tokens.sql
--
-- OXA-1504: CONTRACT phase — drop plaintext OAuth token columns from
-- auth.accounts now that all rows have been backfilled with envelope-encrypted
-- equivalents (access_token_enc, refresh_token_enc) added in migration 0005.
--
-- Only access_token and refresh_token are dropped here; they are bearer
-- credentials and a SOC2 / PCI DSS blocker if stored in plaintext.
-- id_token is retained: it is a read-only OIDC identity assertion, not a
-- bearer credential, and may still be read by Better Auth for profile data.
--
-- PREREQUISITES (must be satisfied before running this migration):
--   1. All auth.accounts rows must have access_token_enc / refresh_token_enc
--      populated (or the original token was NULL).
--   2. The application must no longer READ from access_token / refresh_token
--      (decrypt-then-fallback logic removed from the auth hook).
--
-- Idempotent: DROP COLUMN IF EXISTS is safe to re-run.
--
-- Down migration (documented, not run automatically):
--   ALTER TABLE auth.accounts ADD COLUMN access_token  text;
--   ALTER TABLE auth.accounts ADD COLUMN refresh_token text;

ALTER TABLE "auth"."accounts"
  DROP COLUMN IF EXISTS "access_token",
  DROP COLUMN IF EXISTS "refresh_token";

COMMENT ON COLUMN "auth"."accounts"."access_token_enc"  IS 'AES-256-GCM envelope-encrypted OAuth access token (OXA-1420, OXA-1504). Plaintext column dropped in migration 0012.';
COMMENT ON COLUMN "auth"."accounts"."refresh_token_enc" IS 'AES-256-GCM envelope-encrypted OAuth refresh token (OXA-1420, OXA-1504). Plaintext column dropped in migration 0012.';
