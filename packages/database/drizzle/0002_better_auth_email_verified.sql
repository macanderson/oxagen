-- Better Auth's signup path inserts a boolean `emailVerified` for new users.
-- We previously mapped it to the existing `email_verified_at` timestamp
-- column, which broke because drizzle invoked `.toISOString()` on `false`.
-- Adding a real boolean column lets Better Auth use its default field name
-- and lets us keep `email_verified_at` for our own audit history.
ALTER TABLE "auth"."users"
  ADD COLUMN IF NOT EXISTS "email_verified" boolean NOT NULL DEFAULT false;
