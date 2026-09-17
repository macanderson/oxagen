-- 0028_tacho_events_email_digest.sql
--
-- tacho_events held one readable personal identifier: anthropic_user_email,
-- the real address of the person behind the session. Every other column on the
-- table that identifies a person is a digest, and ClickHouse has no row
-- policy, so that column was the one place an ordinary org-scoped analytics
-- query could read a real address back out (#3072).
--
-- After this migration the table carries anthropic_user_email_digest instead:
-- a SHA-256 written as `sha256:<64 hex>` over a fixed domain string, a NUL
-- byte, and the address lowercased and trimmed. The domain prefix is what
-- stops this being a plain sha256(email) — an address carries so little
-- entropy that a bare hash of one is reversible by anyone holding a list of
-- candidate addresses and willing to hash each. With the prefix, the digest
-- matches nothing a generic table or any other digest in the platform would
-- produce, while still being the same value every time for the same person, so
-- counting distinct people and following one person across sessions both still
-- work. Reading the address back does not.
--
-- The concat/SHA256 expression below is ClickHouse's own reproduction of
-- digestUserEmail() in packages/tacho/src/digest.ts. The two must agree byte
-- for byte, or a backfilled row would never join a newly written one;
-- packages/telemetry/src/tacho-events-email-digest.test.ts pins the expected
-- digest for a known address so a change to either side fails a test.
--
-- The four statements run in order on every plane. The first re-adds the
-- plaintext column when it is missing, because a database created from the
-- regenerated 0027 never had it and the backfill would otherwise fail to
-- parse; on such a database the column is empty and the backfill is a no-op.
-- The last drops it, which removes the addresses from every part on disk.

ALTER TABLE tacho_events ADD COLUMN IF NOT EXISTS anthropic_user_email String;

ALTER TABLE tacho_events ADD COLUMN IF NOT EXISTS anthropic_user_email_digest String;

ALTER TABLE tacho_events UPDATE anthropic_user_email_digest = concat('sha256:', lower(hex(SHA256(concat('oxagen:tacho:user_email:v1\0', lower(trimBoth(anthropic_user_email))))))) WHERE anthropic_user_email != '' AND anthropic_user_email_digest = '' SETTINGS mutations_sync = 2;

ALTER TABLE tacho_events DROP COLUMN IF EXISTS anthropic_user_email;
