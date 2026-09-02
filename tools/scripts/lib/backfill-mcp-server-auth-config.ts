/**
 * Pure, testable core of the mcp_servers.auth_config encryption backfill
 * (OXA-1982). The runner (`tools/scripts/backfill-mcp-server-auth-config.ts`)
 * wires this to a real Postgres connection; the shape-detection logic here is
 * DB-agnostic so it can be unit-tested without a live database.
 */
import { isEncryptedAuthConfig } from "@oxagen/agent/runtime/mcp-server-auth-crypto";

/**
 * True when a `mcp_servers.auth_config` value is legacy PLAINTEXT and still
 * needs to be encrypted: it is a non-empty object that does NOT already match
 * the encrypted shape (`{ v, kmsKeyId, ciphertext }`). Empty (`{}` / null /
 * undefined) rows need no conversion — there is nothing to encrypt.
 */
export function needsBackfill(authConfig: unknown): boolean {
  if (authConfig == null || typeof authConfig !== "object") return false;
  if (Object.keys(authConfig as Record<string, unknown>).length === 0)
    return false;
  return !isEncryptedAuthConfig(authConfig);
}

/** Minimal row shape the backfill needs from mcp.mcp_servers. */
export interface McpServerAuthRow {
  id: string;
  publicId: string;
  authConfig: unknown;
}

/** Partition rows into those needing conversion vs. already-fine rows. */
export function partitionRows(rows: McpServerAuthRow[]): {
  toConvert: McpServerAuthRow[];
  alreadyOk: McpServerAuthRow[];
} {
  const toConvert: McpServerAuthRow[] = [];
  const alreadyOk: McpServerAuthRow[] = [];
  for (const row of rows) {
    (needsBackfill(row.authConfig) ? toConvert : alreadyOk).push(row);
  }
  return { toConvert, alreadyOk };
}
