-- One durable record of the price book's initialization: the instant, and the
-- catalogs that answered completely at it (ADR-103).
--
-- The cold-start floor backdates a key the book has never priced to
-- 2020-01-01, so frames recorded before the first sync price at the first
-- known rate instead of at nothing. It must fire only for a source that was
-- down at initialization and has now come back. Which sources answered then
-- was read off `price_entries` itself: the `catalog` stamped on the rows whose
-- `created_at` equals the book's earliest. That reconstruction cannot see a
-- catalog that answered at the first sync and lost every model to a
-- higher-precedence source, because precedence filtered its rows out before
-- the insert. Such a catalog is indistinguishable from one that was down, so
-- its first unique model inside the seven-day window is read as a recovery and
-- backdated, and the next rollup reprices runs that had already settled.
--
-- Source completion cannot be inferred from rows after precedence has filtered
-- them, so it is recorded. One row per book: `book = 'list'` is the platform
-- list price book, the only book with a cold start (a negotiated book is an
-- organization's own and starts when its contract does). No `org_id` and no
-- `workspace_id`: this is per-install platform state, written and read through
-- `withSystemDb`, so it carries no RLS policy, like `billing.plans` and the
-- other shared catalogs the tenant-policy manifest leaves out.
CREATE TABLE IF NOT EXISTS "cost"."price_book_initializations" (
  "book" text PRIMARY KEY,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid,
  "updated_by_id" uuid,
  "initialized_at" timestamptz NOT NULL,
  "completed_catalogs" text[] NOT NULL DEFAULT '{}',
  CONSTRAINT "price_book_initializations_book_check" CHECK ("book" IN ('list'))
);
