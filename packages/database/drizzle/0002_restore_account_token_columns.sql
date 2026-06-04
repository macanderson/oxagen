-- Restore the access_token / refresh_token columns Better Auth's drizzle
-- adapter writes on OAuth account create/link. They were dropped in 0012
-- (rolled into 0000_baseline) on the assumption a databaseHook would strip
-- them before every write, but Better Auth does not apply that hook on all
-- account write paths, so OAuth sign-in failed with "field does not exist".
-- Nullable; hold LOGIN-client tokens only (low value). The *_enc columns +
-- token-encryption hook remain for proper re-encryption (OXA-1420 follow-up).
ALTER TABLE auth.accounts ADD COLUMN IF NOT EXISTS access_token text;
ALTER TABLE auth.accounts ADD COLUMN IF NOT EXISTS refresh_token text;
