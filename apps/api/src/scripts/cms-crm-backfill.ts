/**
 * Push every website lead the CRM has not confirmed into Attio.
 *
 *   pnpm --filter @oxagen/api cms:crm-backfill [--limit N]        (a laptop)
 *   docker exec oxagen-api node cms-crm-backfill.cjs [--limit N]  (the node)
 *
 * build-node.mjs bundles this file beside server.cjs, so on the app node it
 * runs inside the API container with the container's own environment, which
 * is where production's DATABASE_URL and ATTIO_API_KEY live.
 *
 * Reads cms.leads where crm_synced_at is null, oldest first, and runs the
 * same sync the form handler runs (lib/cms/crm-sync.ts). Needs ATTIO_API_KEY
 * and DATABASE_URL; echoes the database host before touching anything.
 * Re-running is safe: person and company asserts are idempotent, and a lead
 * only leaves the pending set once Attio has confirmed it.
 */

import { isCrmSyncConfigured, syncPendingLeads } from "../lib/cms/crm-sync";

function parseLimit(argv: string[]): number {
  const i = argv.indexOf("--limit");
  if (i < 0) return 500;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit needs a positive integer, got ${argv[i + 1]}`);
  }
  return n;
}

async function main(): Promise<void> {
  if (!isCrmSyncConfigured()) {
    throw new Error("ATTIO_API_KEY is not set; nothing to sync to");
  }
  const target = process.env.DATABASE_URL ?? "";
  const host = target ? new URL(target).host : "(DATABASE_URL unset)";
  console.log(`cms:crm-backfill → database ${host}`);

  const results = await syncPendingLeads({ limit: parseLimit(process.argv) });
  const synced = results.filter((r) => r.status === "synced").length;
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.length - synced - failed.length;
  console.log(
    `${results.length} pending · ${synced} synced · ${failed.length} failed · ${skipped} skipped`,
  );
  for (const r of failed) console.log(`  ${r.leadId}: ${r.error}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
