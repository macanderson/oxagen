// `pnpm env:secrets:pull` — mirror Google Cloud Secret Manager into secrets.db.
//
// For every secret in the project it records: the active (enabled) version, that
// version's createTime (the "last updated" date), and the value — reconciled
// against creds.txt (authoritative/freshest) and .env.local. It then seeds a
// description, a vendor_url, and the apps/packages that consume it. Re-runnable:
// human-edited columns are lock-protected (see secrets-db.ts).
//
// Secret VALUES are read from gcloud into memory and written only to the local,
// gitignored secrets.db. They are never logged.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { openDb, upsertFromPull } from "./secrets-db";
import type { PullUpsert } from "./secrets-db";
import { docFor, resolveEnvKey } from "./secrets-meta";
import { buildEnvRefIndex, deriveUsage } from "./secrets-usage";
import { parseEnvFile, reconcile } from "./secrets-reconcile";

const execFileP = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const PROJECT = process.env.GCP_PROJECT ?? "oxagen-490023";

// ── gcloud helpers ────────────────────────────────────────────────────────────

interface GcloudVersion {
  name: string; // projects/P/secrets/S/versions/N
  createTime: string;
  state: string;
}

async function gcloudJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileP(
    "gcloud",
    [...args, "--format=json", "--project", PROJECT],
    {
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as T;
}

/** All secret names in the project. */
async function listSecretNames(): Promise<string[]> {
  const items = await gcloudJson<{ name: string }[]>(["secrets", "list"]);
  return items
    .map((i) => i.name.split("/").pop() ?? i.name)
    .sort((a, b) => a.localeCompare(b));
}

interface ActiveVersion {
  version: string;
  createTime: string;
}

/** The newest enabled version of a secret (version number + createTime). */
async function activeVersion(secret: string): Promise<ActiveVersion | null> {
  try {
    const versions = await gcloudJson<GcloudVersion[]>([
      "secrets",
      "versions",
      "list",
      secret,
      "--filter=state=enabled",
      "--sort-by=~createTime",
      "--limit=1",
    ]);
    const v = versions[0];
    if (!v) return null;
    return {
      version: v.name.split("/").pop() ?? "?",
      createTime: v.createTime,
    };
  } catch {
    return null;
  }
}

/** Access a specific version's value (raw stdout, never logged). */
async function accessValue(
  secret: string,
  version: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "gcloud",
      [
        "secrets",
        "versions",
        "access",
        version,
        "--secret",
        secret,
        "--project",
        PROJECT,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

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
  const names = await listSecretNames();
  log(`  ${names.length} secrets — fetching versions + values (pool of 8)…`);

  const db = openDb();
  const syncedAt = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  let dupes = 0;
  let missingVals = 0;

  await mapPool(names, 8, async (name) => {
    const active = await activeVersion(name);
    const value = active ? await accessValue(name, active.version) : null;
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
      `${missingVals} with no accessible value.`,
  );
  log(`  → ${join(here, "..", "secrets.db")} (gitignored)`);
}

main().catch((e: unknown) => {
  process.stderr.write(`pull failed: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
