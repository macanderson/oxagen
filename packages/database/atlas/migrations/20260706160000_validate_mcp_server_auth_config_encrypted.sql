-- OXA-2060: validate the NOT VALID constraint added in
-- 20260706141500_encrypt_mcp_server_auth_config.sql, closing the loop
-- documented in that migration's own comments.
--
-- The backfill script (tools/scripts/backfill-mcp-server-auth-config.ts) was
-- run against production on 2026-07-06 in both dry-run and --apply mode and
-- reported 0 rows scanned (mcp.mcp_servers is currently empty in production —
-- no external MCP servers have been registered yet). With zero remaining
-- plaintext rows confirmed, this migration validates the check constraint so
-- Postgres actually scans and enforces it going forward, rather than leaving
-- it perpetually NOT VALID.
--
-- Safe on an empty (or fully-converted) table: VALIDATE CONSTRAINT takes only
-- a SHARE UPDATE EXCLUSIVE lock (does not block reads/writes) and the scan
-- itself is O(rows), trivial at the current row count.

ALTER TABLE mcp.mcp_servers
  VALIDATE CONSTRAINT mcp_servers_auth_config_encrypted_check;
