-- Reconcile columns present in the TS schema + latest snapshot but missing
-- from the journal'd .sql chain (orphaned when the baseline was regenerated):
-- auth.accounts.{access_token,refresh_token} (Better Auth OAuth) and
-- org.organizations.avatar_url. Idempotent so it no-ops on already-migrated DBs.
ALTER TABLE auth.accounts ADD COLUMN IF NOT EXISTS access_token text;
ALTER TABLE auth.accounts ADD COLUMN IF NOT EXISTS refresh_token text;
ALTER TABLE org.organizations ADD COLUMN IF NOT EXISTS avatar_url text;
