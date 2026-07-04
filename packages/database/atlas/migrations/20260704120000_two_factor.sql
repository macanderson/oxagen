-- TOTP two-factor authentication (security-hardening).
--
-- Backs Better Auth's twoFactor plugin, newly registered in packages/auth.
--
-- 1. auth.users.two_factor_enabled — flipped to true only after a user
--    completes first TOTP verification. The app's org-layout gate reads this
--    to enforce MFA for privileged (owner/admin) roles once an org opts into
--    security.org_security_policy.mfa_required.
-- 2. auth.two_factor — one row per enrolled user holding the (encrypted-at-rest)
--    TOTP secret + backup codes. Better Auth resolves this table via the model
--    name "twoFactor", pluralized to "twoFactors" by usePlural:true and wired
--    to this physical table in the Drizzle adapter schema map. Like the other
--    Better-Auth-managed tables (sessions/accounts/rate_limit) the id is text
--    (BA generates it); user_id is uuid to match auth.users.id.
--
-- Hand-written + `atlas migrate hash` because `atlas migrate diff` is broken
-- by the pg_trgm fresh-replay defect
-- (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md).
--
-- Rollback:
--   DROP TABLE IF EXISTS auth.two_factor;
--   ALTER TABLE auth.users DROP COLUMN IF EXISTS two_factor_enabled;

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auth.two_factor (
  id           text PRIMARY KEY,
  user_id      uuid NOT NULL,
  secret       text NOT NULL,
  backup_codes text NOT NULL,
  verified     boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS two_factor_user_id_idx ON auth.two_factor (user_id);
