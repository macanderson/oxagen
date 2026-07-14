-- Batch F3 — webhook_subscriptions provisioning + renewal.
--
-- Provider push subscriptions expire and must be renewed before they lapse:
--   - Microsoft Graph subscriptions live at most ~3 days (expirationDateTime).
--   - Google watch channels (Drive/Gmail/Calendar) expire in ~7 days (expiration).
-- The renewal cron (ingestion.webhook-renew) needs to know WHEN each row expires
-- to re-subscribe ahead of time, so add an `expires_at` column plus an
-- `updated_at` audit stamp (mutated on renewal). A partial index over active
-- rows with a known expiry backs the renewal scan (WHERE status='active' AND
-- expires_at < NOW() + window) without touching the far larger no-expiry set.
ALTER TABLE "ingestion"."webhook_subscriptions"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz NULL,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

-- Renewal-scan index: only active subscriptions that actually expire. Partial so
-- it stays small (webhook-only connectors) and matches the cron's predicate.
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_renewal_idx"
  ON "ingestion"."webhook_subscriptions" ("expires_at")
  WHERE "status" = 'active' AND "expires_at" IS NOT NULL;
