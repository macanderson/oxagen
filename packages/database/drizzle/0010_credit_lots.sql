-- 0010_credit_lots.sql
--
-- Introduces billing.credit_lots: the per-grant, soonest-expiring-first source
-- of truth for credit holdings.  credit_balances is kept as a cached mirror
-- for backward-compatible reads but the lots table is authoritative.
--
-- Expiry rules (enforced by the application, not the DB):
--   free_grant    → expires_at NULL (never expires)
--   subscription  → expires_at = end of grant month (use-it-or-lose-it)
--   purchase      → expires_at = granted_at + 1 year
--
-- Backfill: every existing credit_balances row with balance_cents > 0 is
-- converted into a single 'free_grant' lot so no credits are lost.
--
-- Down migration (documented, not run automatically):
--   DROP TABLE IF EXISTS billing.credit_lots;
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT ... WHERE NOT EXISTS.

CREATE TABLE IF NOT EXISTS billing.credit_lots (
  id             UUID        NOT NULL PRIMARY KEY DEFAULT COALESCE(
                               CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                 THEN uuid_generate_v7()
                                 ELSE uuid_generate_v4()
                               END,
                               uuid_generate_v4()
                             ),
  public_id      CITEXT      NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID,
  updated_by_user_id UUID,

  org_id          UUID        NOT NULL REFERENCES org.organizations(id),
  source          TEXT        NOT NULL,
  original_cents  BIGINT      NOT NULL,
  remaining_cents BIGINT      NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,

  CONSTRAINT credit_lots_source_check
    CHECK (source IN ('free_grant','subscription','purchase')),
  CONSTRAINT credit_lots_remaining_non_negative
    CHECK (remaining_cents >= 0),
  CONSTRAINT credit_lots_remaining_le_original
    CHECK (remaining_cents <= original_cents)
);

CREATE INDEX IF NOT EXISTS credit_lots_org_expiry_idx
  ON billing.credit_lots (org_id, expires_at);

-- Backfill: convert each existing positive balance into a single free_grant
-- lot so no credits are orphaned.  Uses a deterministic public_id built from
-- the credit_balance public_id so re-running is a no-op (unique constraint on
-- public_id rejects the second insert cleanly).
INSERT INTO billing.credit_lots (
  id,
  public_id,
  org_id,
  source,
  original_cents,
  remaining_cents,
  granted_at,
  expires_at
)
SELECT
  COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  -- Prefix the existing credit_balance public_id so there is a deterministic,
  -- collision-free public_id for the backfill lot.
  'clt_backfill_' || cb.public_id,
  cb.org_id,
  'free_grant',
  cb.balance_cents,
  cb.balance_cents,
  COALESCE(cb.last_event_at, cb.created_at),
  NULL  -- free_grant lots never expire
FROM billing.credit_balances cb
WHERE cb.balance_cents > 0
  AND NOT EXISTS (
    SELECT 1 FROM billing.credit_lots cl
    WHERE cl.org_id = cb.org_id
      AND cl.public_id = 'clt_backfill_' || cb.public_id
  )
ON CONFLICT (public_id) DO NOTHING;
