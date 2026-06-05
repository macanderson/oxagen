-- Org avatar/logo column. Nullable: organizations render initials until a logo
-- is uploaded. Holds the public blob URL returned by the storage adapter
-- (@oxagen/storage → Vercel Blob). Additive and idempotent — safe to re-run and
-- a pure column add (no backfill, no default, no lock-heavy rewrite).
ALTER TABLE org.organizations ADD COLUMN IF NOT EXISTS avatar_url text;
