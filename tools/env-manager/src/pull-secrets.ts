// `pnpm env:secrets:pull` — mirror Google Cloud Secret Manager into secrets.db.
//
// For every secret in the project it records: the active (enabled) version, that
// version's createTime (the "last updated" date), and the value — reconciled
// against creds.txt and .env.local, preserving any GCP value. It then seeds a
// description, a vendor_url, and the apps/packages that consume it. Re-runnable:
// human-edited columns are lock-protected (see secrets-db.ts).
//
// Secret VALUES are read from gcloud into memory and written only to the local,
// gitignored secrets.db. They are never logged.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { fetchSecret, listSecretNames } from "./gcloud-secrets";
import { openDb, upsertFromPull } from "./secrets-db";
import type { PullUpsert } from "./secrets-db";
import { docFor, resolveEnvKey } from "./secrets-meta";
import { buildEnvRefIndex, deriveUsage } from "./secrets-usage";
import { parseEnvFile, reconcile } from "./secrets-reconcile";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const PROJECT = process.env.GCP_PROJECT ?? "oxagen-490023";

// ── Concurrency pool ───────────────────────────────────────────────────────────

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        const item = items[i];
        if (item === undefined) continue;
        results[i] = await fn(item, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const log = (m: string) => process.stdout.write(`${m}\n`);
  log(`env:secrets:pull → project ${PROJECT}`);

  const creds = parseEnvFile(join(REPO_ROOT, "creds.txt"));
  const envLocal = parseEnvFile(join(REPO_ROOT, ".env.local"));
  log(
    `  parsed creds.txt (${creds.size} keys) · .env.local (${envLocal.size} keys)`,
  );

  log(`  scanning codebase for env-var references…`);
  const refIndex = buildEnvRefIndex(REPO_ROOT);

  log(`  listing secrets…`);
  const names = await listSecretNames(PROJECT);
  log(`  ${names.length} secrets — fetching versions + values (pool of 8)…`);

  const db = openDb();
  const syncedAt = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  let dupes = 0;
  let missingVals = 0;
  const failures: { name: string; message: string }[] = [];

  await mapPool(names, 8, async (name) => {
    const fetched = await fetchSecret(name, PROJECT);
    if (!fetched.ok) {
      // gcloud failed for a reason other than NOT_FOUND. Keep the last good
      // row rather than overwrite it with a missing value.
      failures.push({ name, message: fetched.message });
      return;
    }
    const { active, value } = fetched;
    if (value === null) missingVals++;

    const envKey = resolveEnvKey(name);
    const rec = reconcile(name, envKey, value, creds, envLocal);
    if (rec.isDuplicate) dupes++;
    const doc = docFor(name, envKey);
    const usage = deriveUsage(envKey, refIndex);

    const upsert: PullUpsert = {
      key: name,
      value: rec.value,
      value_source: rec.source,
      active_version: active?.version ?? null,
      updated_at: active?.createTime ?? null,
      is_duplicate: rec.isDuplicate,
      env_key: envKey,
      seedDescription: doc.description,
      seedVendorUrl: doc.vendor_url,
      seedUsage: usage,
    };
    const r = upsertFromPull(db, upsert, syncedAt);
    if (r === "inserted") inserted++;
    else updated++;
  });

  log(
    `\n  done: ${inserted} inserted, ${updated} updated, ${dupes} reconciled vs local files, ` +
      `${missingVals} with no value in Secret Manager, ${failures.length} failed.`,
  );
  log(`  → ${join(here, "..", "secrets.db")} (gitignored)`);
  if (failures.length > 0) {
    failures.sort((a, b) => a.name.localeCompare(b.name));
    process.stderr.write(
      `\n  gcloud failed for ${failures.length} secret(s). Their rows were left unchanged:\n`,
    );
    for (const f of failures) {
      process.stderr.write(`    ${f.name}: ${f.message}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`pull failed: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
