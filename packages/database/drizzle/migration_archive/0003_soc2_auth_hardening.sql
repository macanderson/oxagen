-- 0003_soc2_auth_hardening.sql
--
-- SOC2 auth hardening — three independent gap-fills:
--
--   (A) rate_limit table for Better Auth database-backed brute-force defense.
--       Stored in the `auth` schema beside the other auth tables.
--       Better Auth resolves the model "rateLimit" → schema key "rateLimit".
--       Fields: id (text PK, BA generates), key (text unique), count (int),
--       lastRequest (bigint ms-since-epoch).
--
--   (B) Postgres trigger on auth.accounts BEFORE INSERT OR UPDATE that nulls
--       each plaintext token column when its *_enc encrypted counterpart is
--       NOT NULL.  Defense-in-depth backstop: Better Auth may bypass the
--       application-layer databaseHook on some write paths; the trigger
--       guarantees the plaintext is never durably stored once encrypted.
--       Safe invariant: we never null a plaintext col when *_enc IS NULL —
--       we would destroy the only copy.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS auth_accounts_strip_plaintext_tokens ON auth.accounts;
--   DROP FUNCTION IF EXISTS auth.strip_plaintext_tokens();
--   DROP TABLE IF EXISTS auth.rate_limit;

-- ── (A) rate_limit table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth.rate_limit (
    id           TEXT PRIMARY KEY,
    key          TEXT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    -- lastRequest stored as bigint (ms since Unix epoch); bigint avoids
    -- timestamp precision/timezone surprises and matches Better Auth's
    -- internal representation (Date.now()).
    "lastRequest" BIGINT NOT NULL DEFAULT 0
);

-- Better Auth looks up records by key on every request; unique ensures
-- exactly one record per (ip, path) pair.
CREATE UNIQUE INDEX IF NOT EXISTS rate_limit_key_idx ON auth.rate_limit (key);

-- ── (B) strip-plaintext-tokens trigger ─────────────────────────────────────

CREATE OR REPLACE FUNCTION auth.strip_plaintext_tokens()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Null each plaintext column only when its encrypted counterpart is
    -- present — so we never destroy the only copy of a token.
    -- Defense-in-depth: the application hook (buildAccountTokenHooks /
    -- buildStripOnlyAccountHooks in packages/auth) already strips on the
    -- covered write paths; this trigger is the backstop for any Better Auth
    -- write path that bypasses the application-layer databaseHook (e.g.
    -- internal account-linking flows, future BA version changes).
    IF NEW.access_token_enc IS NOT NULL THEN
        NEW.access_token := NULL;
    END IF;
    IF NEW.refresh_token_enc IS NOT NULL THEN
        NEW.refresh_token := NULL;
    END IF;
    IF NEW.id_token_enc IS NOT NULL THEN
        NEW.id_token := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_accounts_strip_plaintext_tokens ON auth.accounts;

CREATE TRIGGER auth_accounts_strip_plaintext_tokens
    BEFORE INSERT OR UPDATE ON auth.accounts
    FOR EACH ROW
    EXECUTE FUNCTION auth.strip_plaintext_tokens();
