#!/usr/bin/env tsx
/**
 * backfill-mcp-server-auth-config.ts — OXA-1982
 *
 * Encrypts legacy PLAINTEXT `mcp.mcp_servers.auth_config` rows in place.
 * Externally-registered MCP servers used to persist bearer-token/header
 * secrets in the clear; the write/read paths (agent.mcp.register,
 * agent.mcp.set_enabled, the mcp plugin-type contributor) now envelope-
 * encrypt via packages/agent/src/runtime/mcp-server-auth-crypto.ts. This
 * script converts every row written before that fix landed.
 *
 * Companion Atlas migration:
 *   packages/database/atlas/migrations/20260706141500_encrypt_mcp_server_auth_config.sql
 * adds a NOT VALID check constraint establishing the going-forward invariant
 * (auth_config is empty or already encrypted). Run this script after that
 * migration + the code deploy land; once it reports zero remaining plaintext
 * rows, a follow-up migration can `VALIDATE CONSTRAINT
 * mcp_servers_auth_config_encrypted_check`.
 *
 * Algorithm:
 *   1. Select every mcp.mcp_servers row's (id, publicId, auth_config).
 *   2. Partition into rows needing conversion (non-empty, not already the
 *      { v, kmsKeyId, ciphertext } shape) vs. already-fine rows.
 *   3. For each row needing conversion: encrypt its plaintext record via
 *      encryptMcpAuthConfig() and UPDATE that row's auth_config.
 *
 * Safety:
 *   - Defaults to --dry-run; pass --apply to write.
 *   - Prints the sanitized target host + database at startup.
 *   - Requires explicit confirmation (Y/n) before --apply on a non-local host.
 *   - Idempotent: a row already in the encrypted shape (or empty) is skipped,
 *     so re-running mid-way or after a partial failure is safe.
 *   - Per-row failure is isolated — one bad row does not abort the rest.
 *
 * Usage:
 *   tsx tools/scripts/backfill-mcp-server-auth-config.ts              # dry-run
 *   tsx tools/scripts/backfill-mcp-server-auth-config.ts --apply      # write changes
 *
 * Env:
 *   DATABASE_URL, AUTH_TOKEN_ENCRYPTION_KEY — both required (the latter is the
 *   KEK that wraps every row's data-encryption key; without it there is
 *   nothing to encrypt with).
 *   tsx --env-file does NOT override a shell-set DATABASE_URL — unset it to
 *   force local targeting. Always double-check the printed target host
 *   before running --apply.
 */

import { createInterface } from "node:readline";
import { URL } from "node:url";
import kleur from "kleur";
import { eq } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import { db, closeDatabase, schema } from "@oxagen/database";
import { encryptMcpAuthConfig } from "@oxagen/agent/runtime/mcp-server-auth-crypto";
import { formatError } from "./lib/format-error";
import {
  partitionRows,
  type McpServerAuthRow,
} from "./lib/backfill-mcp-server-auth-config";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");

function sanitizeUrl(raw: string): { host: string; database: string } {
  try {
    const u = new URL(raw);
    return {
      host: `${u.hostname}:${u.port || "5432"}`,
      database: u.pathname.replace(/^\//, "") || "(default)",
    };
  } catch {
    return { host: "(unparseable)", database: "(unparseable)" };
  }
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(host);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

interface RowResult {
  publicId: string;
  status: "converted" | "would-convert" | "skipped" | "failed";
  error?: string;
}

async function main(): Promise<void> {
  const start = Date.now();

  const env = requireEnv(["DATABASE_URL", "AUTH_TOKEN_ENCRYPTION_KEY"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(
    kleur.cyan("┌─────────────────────────────────────────────────────────┐"),
  );
  console.log(
    kleur.cyan("│  backfill-mcp-server-auth-config — OXA-1982 encryption   │"),
  );
  console.log(
    kleur.cyan("└─────────────────────────────────────────────────────────┘"),
  );
  console.log();
  console.log(`  Target host  : ${kleur.yellow(host)}`);
  console.log(`  Database     : ${kleur.yellow(database)}`);
  console.log(
    `  Mode         : ${DRY_RUN ? kleur.blue("DRY RUN (read-only)") : kleur.red("APPLY (will write)")}`,
  );
  console.log();

  if (!DRY_RUN && !isLocalHost(host)) {
    console.log(kleur.red("  ⚠  Non-local database detected in --apply mode."));
    const ok = await confirm(
      "  Proceed with write to production database? [y/N] ",
    );
    if (!ok) {
      console.log(kleur.yellow("  Aborted."));
      process.exit(0);
    }
    console.log();
  }

  const d = db();

  const allRows: McpServerAuthRow[] = await d
    .select({
      id: schema.mcpServers.id,
      publicId: schema.mcpServers.publicId,
      authConfig: schema.mcpServers.authConfig,
    })
    .from(schema.mcpServers);

  const { toConvert, alreadyOk } = partitionRows(allRows);

  console.log(
    kleur.cyan(
      `[backfill-mcp-auth] ${allRows.length} row(s) found — ${toConvert.length} need encryption, ${alreadyOk.length} already fine.`,
    ),
  );
  console.log();

  const results: RowResult[] = [];

  for (const row of toConvert) {
    if (DRY_RUN) {
      console.log(
        kleur.blue(`  [dry-run] ${row.publicId} — WOULD encrypt auth_config`),
      );
      results.push({ publicId: row.publicId, status: "would-convert" });
      continue;
    }
    try {
      const encrypted = await encryptMcpAuthConfig(
        row.authConfig as Record<string, string>,
      );
      await d
        .update(schema.mcpServers)
        .set({ authConfig: encrypted })
        .where(eq(schema.mcpServers.id, row.id));
      console.log(kleur.green(`  [converted] ${row.publicId}`));
      results.push({ publicId: row.publicId, status: "converted" });
    } catch (err: unknown) {
      const msg = formatError(err);
      console.log(kleur.red(`  [fail] ${row.publicId} — ${msg}`));
      results.push({ publicId: row.publicId, status: "failed", error: msg });
    }
  }

  const converted = results.filter((r) => r.status === "converted").length;
  const wouldConvert = results.filter(
    (r) => r.status === "would-convert",
  ).length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalMs = Date.now() - start;

  console.log();
  console.log(
    kleur.cyan("─────────────────────────────────────────────────────────"),
  );
  console.log(kleur.cyan(`[backfill-mcp-auth] Summary (${totalMs}ms)`));
  console.log(`  Rows scanned         : ${allRows.length}`);
  console.log(
    `  Already encrypted    : ${kleur.dim(String(alreadyOk.length))}`,
  );
  if (DRY_RUN) {
    console.log(`  Would convert        : ${kleur.blue(String(wouldConvert))}`);
  } else {
    console.log(
      `  Converted            : ${converted > 0 ? kleur.green(String(converted)) : kleur.dim("0")}`,
    );
  }
  console.log(
    `  Failed               : ${failed > 0 ? kleur.red(String(failed)) : kleur.dim("0")}`,
  );

  if (failed > 0) {
    console.log();
    console.log(kleur.red("[backfill-mcp-auth] Failed rows:"));
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(kleur.red(`  - ${r.publicId}: ${r.error}`));
    }
  }

  if (DRY_RUN) {
    console.log();
    console.log(
      kleur.blue(
        "[backfill-mcp-auth] This was a dry-run. Re-run with --apply to write changes.",
      ),
    );
  }

  await closeDatabase();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(kleur.red(`[backfill-mcp-auth] Failed: ${formatError(err)}`));
  process.exit(1);
});
