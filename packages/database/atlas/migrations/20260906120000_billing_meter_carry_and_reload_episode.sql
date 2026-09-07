-- Two billing defects that both come down to a number with nowhere to live.
--
-- meter_carry_micro_credits (#1413) — the credit ledger holds whole credits and
-- one credit is a cent, so a call worth a fraction of a cent could not be
-- debited as itself. The meter rounded every call UP, which charged a 200-token
-- embedding 739x its cost; the platform makes one embedding call per ingested
-- entity, so a 100,000-chunk ingest worth $1.35 billed $1,000. The meter now
-- computes in micro-credits (1 credit = 1,000,000) and banks the sub-credit
-- remainder here, debiting a whole credit only once the fractions add up to
-- one. Exact over a sequence of calls, and the ledger stays integral.
-- consumeCredits accumulates and writes back the remainder inside the same
-- transaction as the debit, so a crash can neither charge a fraction twice nor
-- lose it. Between transactions the value is always in [0, 1000000); the CHECK
-- is only the lower bound, because the accumulating statement writes the running
-- total before the same transaction reduces it to the remainder.
--
-- auto_reload_episode_key / _started_at (#1420) — auto-reload's Stripe
-- idempotency key was derived from the calendar hour, while the retry it exists
-- to protect is bounded by elapsed time. When a charge succeeded and the credit
-- grant then failed, the documented self-heal retried the charge — and a retry
-- 40 seconds after a 10:59:30 charge computed a different key, so Stripe did not
-- de-duplicate it and the card was charged a second time while the customer was
-- still uncredited. The key is now a fact the row carries: written before the
-- card is charged, reused by every retry, and cleared only once the credits are
-- granted. _started_at bounds that reuse — past Stripe's 24-hour idempotency
-- window the same key would charge again, so an episode older than that stops
-- retrying and alerts instead.
--
-- Additive. Every column is nullable or defaulted, so existing rows are valid as
-- they stand: no reload is in flight, and nothing is carried.
ALTER TABLE "billing"."org_billing_settings"
  ADD COLUMN IF NOT EXISTS "meter_carry_micro_credits" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "auto_reload_episode_key" text NULL,
  ADD COLUMN IF NOT EXISTS "auto_reload_episode_started_at" timestamptz NULL;

ALTER TABLE "billing"."org_billing_settings"
  ADD CONSTRAINT "org_billing_settings_meter_carry_non_negative"
  CHECK ("meter_carry_micro_credits" >= 0);

-- Ops reconciliation: find the orgs whose reload is charged but not granted.
-- Partial, so it indexes only the rows that are actually in that state — which
-- is normally none of them.
CREATE INDEX IF NOT EXISTS "org_billing_settings_open_reload_episode_idx"
  ON "billing"."org_billing_settings" ("auto_reload_episode_started_at")
  WHERE "auto_reload_episode_key" IS NOT NULL;
