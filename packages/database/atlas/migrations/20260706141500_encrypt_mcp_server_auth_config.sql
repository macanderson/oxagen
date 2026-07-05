-- OXA-1982: encrypt external MCP server credentials.
--
-- mcp.mcp_servers.auth_config previously stored bearer-token / header-secret
-- credentials as PLAINTEXT jsonb — inconsistent with plugin-linked MCP
-- servers, whose secrets already flow through the envelope-encrypted
-- mcp.credentials path (packages/plugins/src/credentials). The app layer now
-- envelope-encrypts auth_config before every write and decrypts on every read
-- (packages/agent/src/runtime/mcp-server-auth-crypto.ts), reusing the SAME
-- AES-256-GCM envelope + local-KEK KMS adapter as mcp.credentials, under a
-- distinct key-id label (mcp_server_auth_v1) for independent rotation.
--
-- Column type is UNCHANGED (still jsonb) — only its contents' shape changes:
--   '{}'::jsonb                                — no secrets (authStrategy='none').
--   {"v":1,"kmsKeyId":"...","ciphertext":"..."} — encrypted secrets.
--
-- Encrypting existing PLAINTEXT rows requires the app's Node crypto + KMS
-- adapter (AES-256-GCM envelope wrapping is not expressible in plain SQL), so
-- the actual data conversion is a companion script, NOT this migration:
--   tools/scripts/backfill-mcp-server-auth-config.ts
-- Run it once after this migration + the code deploy land (dry-run by
-- default; --apply to write). It is idempotent — already-encrypted or empty
-- rows are skipped.
--
-- This migration adds a NOT VALID check constraint establishing the
-- going-forward invariant: every row's auth_config is either empty or already
-- in the encrypted shape. NOT VALID means Postgres does NOT scan existing
-- rows (so this migration is safe to apply before the backfill script runs);
-- new/updated rows are enforced immediately. Once the backfill script reports
-- zero remaining plaintext rows, a follow-up migration should run
-- `VALIDATE CONSTRAINT mcp_servers_auth_config_encrypted_check` to close the
-- loop and confirm no plaintext rows remain.
--
-- Hand-written + `atlas migrate hash` because `atlas migrate diff` is broken
-- by the pg_trgm fresh-replay defect
-- (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md).

ALTER TABLE mcp.mcp_servers
  DROP CONSTRAINT IF EXISTS mcp_servers_auth_config_encrypted_check;

ALTER TABLE mcp.mcp_servers
  ADD CONSTRAINT mcp_servers_auth_config_encrypted_check
  CHECK (
    auth_config = '{}'::jsonb
    OR (auth_config ? 'ciphertext' AND auth_config ? 'kmsKeyId')
  ) NOT VALID;
