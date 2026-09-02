// Local SQLite mirror of Google Cloud Secret Manager + a few human-owned columns.
//
// Identity is the GCP secret name (`key`). Each row carries two kinds of column:
//
//  - MACHINE-owned (refreshed on every pull): active_version, updated_at, and the
//    reconciled value (GCP value, overridden by a fresher creds.txt match).
//  - HUMAN-owned (seeded once, then preserved): description, vendor_url, usage
//    (which apps/packages consume it) and — because the operator asked for an
//    editable spreadsheet — value itself.
//
// Human edits are protected by per-column `*_locked` flags: the moment the UI
// PATCHes a field we set its lock, and the puller then refuses to overwrite it.
// This is what makes `pnpm env:secrets:pull` safe to re-run forever.
//
// node:sqlite (Node 24 built-in) keeps this dependency-free. SQLite has no array
// type, so `usage` is stored as a JSON string and parsed at the boundary.
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load the builtin at runtime via require: vite-node (used by vitest) strips the
// `node:` prefix off a static `import … from "node:sqlite"` and then fails to
// resolve a bare "sqlite" package. createRequire bypasses that transform; the
// DB type is derived from the runtime value so we keep full typing.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire(
  "node:sqlite",
) as typeof import("node:sqlite");
type DB = InstanceType<typeof DatabaseSync>;

const here = dirname(fileURLToPath(import.meta.url));
/** secrets.db lives at the env-manager package root (gitignored). */
export const DB_PATH = join(here, "..", "secrets.db");

/** Where the freshest value for a secret came from. */
export type ValueSource =
  | "gcp"
  | "creds.txt"
  | ".env.local"
  | "manual"
  | "missing";

/** One secret row as stored — `usage` already parsed from its JSON column. */
export interface SecretRow {
  key: string;
  value: string | null;
  value_source: ValueSource;
  active_version: string | null;
  updated_at: string | null;
  description: string;
  vendor_url: string;
  /** Which apps/packages consume this secret (e.g. ["app", "@pkg/ai"]). */
  usage: string[];
  /** Reconciled registry env var name, when the GCP secret maps to one. */
  env_key: string | null;
  /** True when the secret matched a key in creds.txt / .env.local. */
  is_duplicate: boolean;
  /** Per-column human-edit locks — set by the API, honored by the puller. */
  value_locked: boolean;
  desc_locked: boolean;
  vendor_locked: boolean;
  usage_locked: boolean;
  synced_at: string | null;
}

/** The machine-owned fields the puller computes for each GCP secret. */
export interface PullUpsert {
  key: string;
  value: string | null;
  value_source: ValueSource;
  active_version: string | null;
  updated_at: string | null;
  is_duplicate: boolean;
  env_key: string | null;
  /** Seed values — only applied to NEW rows or unlocked columns. */
  seedDescription: string;
  seedVendorUrl: string;
  seedUsage: string[];
}

/**
 * Create a fresh DB connection and ensure the schema exists (no caching).
 *
 * The file holds live secret values in plaintext, so it is narrowed to
 * owner-only (0600) — SQLite would otherwise create it under the process umask,
 * which on a stock macOS/Linux account is world-readable 0644. Best-effort:
 * `:memory:` databases and filesystems without POSIX modes have nothing to
 * chmod, and failing to tighten the mode must not stop the tool from running.
 */
export function createDb(path: string): DB {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Non-POSIX filesystem or a pre-existing file we don't own — leave as is.
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      key            TEXT PRIMARY KEY,
      value          TEXT,
      value_source   TEXT NOT NULL DEFAULT 'missing',
      active_version TEXT,
      updated_at     TEXT,
      description    TEXT NOT NULL DEFAULT '',
      vendor_url     TEXT NOT NULL DEFAULT '',
      usage          TEXT NOT NULL DEFAULT '[]',
      env_key        TEXT,
      is_duplicate   INTEGER NOT NULL DEFAULT 0,
      value_locked   INTEGER NOT NULL DEFAULT 0,
      desc_locked    INTEGER NOT NULL DEFAULT 0,
      vendor_locked  INTEGER NOT NULL DEFAULT 0,
      usage_locked   INTEGER NOT NULL DEFAULT 0,
      synced_at      TEXT
    );
  `);
  return db;
}

let _db: DB | null = null;

/**
 * Open (and migrate) the on-disk secrets DB, cached per-process for the server.
 *
 * The cache is keyed on nothing: the FIRST call wins and every later call gets
 * that same connection back, `path` included. Pass a different path only from a
 * process that has not opened one yet (or use `createDb` directly, which never
 * caches) — otherwise the argument is silently ignored.
 *
 * Note this creates the file when it is absent rather than failing, so an empty
 * result means "never pulled", not "no such database".
 */
export function openDb(path: string = DB_PATH): DB {
  if (_db) return _db;
  _db = createDb(path);
  return _db;
}

function parseUsage(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** Shape of a raw row as node:sqlite returns it (INTEGER booleans). */
interface RawSecretRow {
  key: string;
  value: string | null;
  value_source: string;
  active_version: string | null;
  updated_at: string | null;
  description: string;
  vendor_url: string;
  usage: string;
  env_key: string | null;
  is_duplicate: number;
  value_locked: number;
  desc_locked: number;
  vendor_locked: number;
  usage_locked: number;
  synced_at: string | null;
}

function hydrate(r: RawSecretRow): SecretRow {
  return {
    key: r.key,
    value: r.value,
    value_source: r.value_source as ValueSource,
    active_version: r.active_version,
    updated_at: r.updated_at,
    description: r.description,
    vendor_url: r.vendor_url,
    usage: parseUsage(r.usage),
    env_key: r.env_key,
    is_duplicate: r.is_duplicate === 1,
    value_locked: r.value_locked === 1,
    desc_locked: r.desc_locked === 1,
    vendor_locked: r.vendor_locked === 1,
    usage_locked: r.usage_locked === 1,
    synced_at: r.synced_at,
  };
}

/** All rows, ordered by key. */
export function listSecrets(db: DB): SecretRow[] {
  const rows = db
    .prepare(`SELECT * FROM secrets ORDER BY key ASC`)
    .all() as unknown as RawSecretRow[];
  return rows.map(hydrate);
}

/** A single row, or null. */
export function getSecret(db: DB, key: string): SecretRow | null {
  const row = db
    .prepare(`SELECT * FROM secrets WHERE key = ?`)
    .get(key) as unknown as RawSecretRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Merge a pull result into the table. New rows take all seed values; existing
 * rows refresh machine columns but keep any human-locked column untouched.
 * Returns whether the row was newly inserted.
 */
export function upsertFromPull(
  db: DB,
  u: PullUpsert,
  syncedAt: string,
): "inserted" | "updated" {
  const existing = getSecret(db, u.key);
  if (!existing) {
    db.prepare(
      `INSERT INTO secrets
        (key, value, value_source, active_version, updated_at, description, vendor_url, usage, env_key, is_duplicate, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.key,
      u.value,
      u.value_source,
      u.active_version,
      u.updated_at,
      u.seedDescription,
      u.seedVendorUrl,
      JSON.stringify(u.seedUsage),
      u.env_key,
      u.is_duplicate ? 1 : 0,
      syncedAt,
    );
    return "inserted";
  }

  // Machine columns always refresh; value only when the operator hasn't pinned it.
  const value = existing.value_locked ? existing.value : u.value;
  const valueSource = existing.value_locked
    ? existing.value_source
    : u.value_source;
  const description = existing.desc_locked
    ? existing.description
    : u.seedDescription || existing.description;
  const vendorUrl = existing.vendor_locked
    ? existing.vendor_url
    : u.seedVendorUrl || existing.vendor_url;
  const usage = existing.usage_locked
    ? existing.usage
    : mergeUsage(existing.usage, u.seedUsage);

  db.prepare(
    `UPDATE secrets SET
       value = ?, value_source = ?, active_version = ?, updated_at = ?,
       description = ?, vendor_url = ?, usage = ?, env_key = ?, is_duplicate = ?, synced_at = ?
     WHERE key = ?`,
  ).run(
    value,
    valueSource,
    u.active_version,
    u.updated_at,
    description,
    vendorUrl,
    JSON.stringify(usage),
    u.env_key,
    u.is_duplicate ? 1 : 0,
    syncedAt,
    u.key,
  );
  return "updated";
}

/** Union two usage lists, preserving order (existing first), deduped. */
function mergeUsage(existing: string[], seed: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const s of seed)
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  return out;
}

/** Editable columns the spreadsheet UI may PATCH. */
export type EditableField = "value" | "description" | "vendor_url" | "usage";

const LOCK_FOR: Record<EditableField, string> = {
  value: "value_locked",
  description: "desc_locked",
  vendor_url: "vendor_locked",
  usage: "usage_locked",
};

/**
 * Apply a human edit from the UI and lock that column against future pulls.
 * `usage` is given as an array and stored as JSON. Editing `value` flips its
 * source to "manual". Returns the updated row.
 */
export function editSecret(
  db: DB,
  key: string,
  field: EditableField,
  value: string | string[],
): SecretRow {
  if (!getSecret(db, key)) throw new Error(`unknown secret: ${key}`);
  const lock = LOCK_FOR[field];

  if (field === "usage") {
    const arr = Array.isArray(value) ? value : [value];
    db.prepare(`UPDATE secrets SET usage = ?, ${lock} = 1 WHERE key = ?`).run(
      JSON.stringify(arr),
      key,
    );
  } else if (field === "value") {
    const v = Array.isArray(value) ? value.join(",") : value;
    db.prepare(
      `UPDATE secrets SET value = ?, value_source = 'manual', ${lock} = 1 WHERE key = ?`,
    ).run(v, key);
  } else {
    const v = Array.isArray(value) ? value.join(",") : value;
    db.prepare(
      `UPDATE secrets SET ${field} = ?, ${lock} = 1 WHERE key = ?`,
    ).run(v, key);
  }

  const updated = getSecret(db, key);
  if (!updated) throw new Error(`secret vanished after edit: ${key}`);
  return updated;
}
