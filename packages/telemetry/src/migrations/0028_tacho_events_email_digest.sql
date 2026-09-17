-- 0028_tacho_events_email_digest.sql
--
-- tacho_events held one readable personal identifier: anthropic_user_email,
-- the real address of the person behind the session. Every other column on the
-- table that identifies a person is a digest, and ClickHouse has no row
-- policy, so that column was the one place an ordinary org-scoped analytics
-- query could read a real address back out (#3072).
--
-- The table now carries anthropic_user_email_digest instead. The control plane
-- stamps it with an HMAC key held only by the API deployment
-- (packages/handlers/src/lib/tacho-user-email-digest.ts), so the reader this
-- defect is about cannot turn it back into an address. An unkeyed hash would
-- not have been enough: an address carries so little entropy that whoever can
-- read the column can guess a colleague's address, hash it and compare, and a
-- published domain prefix does not change that — it only rules out a generic
-- precomputed table.
--
-- NOTHING IS BACKFILLED, deliberately. The digest is keyed, and the key has no
-- business in a migration: ClickHouse has no HMAC function to call it with, and
-- passing the secret into a statement would write it into the query log, which
-- is one more place to read it from. So the rows already written lose the
-- attribute rather than gaining a digest. That is the stronger outcome for the
-- defect this closes — the addresses are gone, not re-encoded — and it costs
-- only the ability to attribute historical sessions to a person, which nothing
-- read: the address reached one contract output field and no screen.

ALTER TABLE tacho_events ADD COLUMN IF NOT EXISTS anthropic_user_email_digest String;

ALTER TABLE tacho_events DROP COLUMN IF EXISTS anthropic_user_email;
