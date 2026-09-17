#!/usr/bin/env node
/**
 * Two ClickHouse migrations must not share a numeric prefix.
 *
 * `migrate()` (packages/telemetry/src/migrate.ts) picks the order it applies
 * files in with `readdirSync(migrationsDir).sort()` — a sort of the WHOLE
 * filename, not of the leading ordinal. Two files under one ordinal therefore
 * order by whatever comes after the underscore, which is not a thing anybody
 * chose. `0020_error_events.sql` runs before `0020_eval_item_results.sql`
 * because `r` sorts before `v`.
 *
 * Today that is harmless, because the four files it affects create and alter
 * unrelated tables. That is the trap: it works silently, by an accident of
 * spelling, and the next duplicate pair to arrive might have a real dependency
 * between its two halves — a CREATE in one and an ALTER of the same table in
 * the other. Then the alphabetical tie-break decides whether a fresh database
 * migrates or fails, and nothing tells anyone which way it went. The ordinal is
 * the only place the intended order is written down, so it has to be unique.
 *
 * Postgres has the same guard next door — db-lint-migrations.ts rejects two
 * Atlas migrations sharing a version prefix, because atlas keys revisions by
 * that prefix and silently skips the loser. #2202 asked for this one to live
 * there too; it lives here instead, beside check-main-concurrency.mjs, because
 * this is a lint over a directory rather than a check of Atlas's own state, and
 * `check:contracts` and `db:lint-migrations` run on the same CI line so the
 * gate is identical either way.
 *
 * The four files already on disk under a duplicated ordinal are grandfathered
 * by exact name, with the reason on each. They are NOT renamed, because
 * renaming a shipped migration is the more dangerous operation of the two —
 * see GRANDFATHERED below. New duplicates are refused.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = join(
  repoRoot,
  "packages",
  "telemetry",
  "src",
  "migrations",
);

/**
 * Filenames permitted to share an ordinal, each with why it is not renamed.
 *
 * The shared constraint behind all four: `_migrations.filename` is the ledger's
 * only key. Renaming a file that a deployment has already applied makes the new
 * name unrecorded, so the file runs again — the exact replay the ledger exists
 * to end. The rename also moves the file within `PRE_LEDGER_BASELINE_CUTOVER`'s
 * `f <= cutover` sweep, so a deployment still upgrading into the ledger would
 * classify it differently than the cutover's author intended.
 *
 * Per file, on top of that:
 *
 *   0020_error_events.sql
 *     Creates `error_events`. `0022_error_events_execution_id.sql` runs
 *     `ALTER TABLE error_events` three times. Renaming this file to a free
 *     ordinal (0028+) moves it AFTER 0022, so a fresh database would alter a
 *     table that does not exist yet and the migration would fail outright.
 *
 *   0020_eval_item_results.sql
 *     Creates `eval_item_results`, which nothing else in migrations/ touches.
 *     Renamable in principle; left alone because the pair only stops being a
 *     duplicate if BOTH halves keep their ordinal or the OTHER half moves, and
 *     the other half cannot move.
 *
 *   0026_cache_write_tokens.sql
 *     `ALTER TABLE token_usage` — token_usage is defined in schema.sql, which
 *     is re-applied before every migration run, so this one has no ordering
 *     dependency inside migrations/. Left alone for the ledger-key reason only.
 *
 *   0026_stella_operational_events.sql
 *     This filename is the literal value of `PRE_LEDGER_BASELINE_CUTOVER` in
 *     migrate.ts. Renaming it changes which files the one-time pre-ledger
 *     bootstrap sweeps into the baseline, for every deployment that has not yet
 *     run the ledger — a behaviour change with no visible cause.
 *
 * No new entries. A new migration takes the next free ordinal.
 */
export const GRANDFATHERED = Object.freeze([
  "0020_error_events.sql",
  "0020_eval_item_results.sql",
  "0026_cache_write_tokens.sql",
  "0026_stella_operational_events.sql",
]);

/** The leading numeric prefix, or null for a filename that has none. */
export function ordinalOf(filename) {
  const m = /^(\d+)_/.exec(filename);
  return m ? m[1] : null;
}

/**
 * Ordinals claimed by more than one file, as `{ ordinal, files }`, sorted.
 * Files with no numeric prefix are reported separately by `unprefixed`.
 */
export function duplicateOrdinals(filenames) {
  const byOrdinal = new Map();
  for (const f of filenames) {
    const ord = ordinalOf(f);
    if (ord === null) continue;
    const bucket = byOrdinal.get(ord);
    if (bucket) bucket.push(f);
    else byOrdinal.set(ord, [f]);
  }
  return [...byOrdinal.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([ordinal, files]) => ({ ordinal, files: [...files].sort() }))
    .sort((a, b) => a.ordinal.localeCompare(b.ordinal));
}

/** `.sql` files whose name does not start with a numeric prefix. */
export function unprefixed(filenames) {
  return filenames.filter((f) => ordinalOf(f) === null).sort();
}

/**
 * Duplicate groups that are not fully grandfathered.
 *
 * The exemption is per FILENAME, not per ordinal: adding a third file under
 * 0020 is a new duplicate even though the two files already there are exempt,
 * and it is reported with the whole group so the reader can see what it collides
 * with.
 */
export function offendingDuplicates(filenames, exempt = GRANDFATHERED) {
  const allowed = new Set(exempt);
  return duplicateOrdinals(filenames).map(({ ordinal, files }) => ({
    ordinal,
    files,
    unexempt: files.filter((f) => !allowed.has(f)),
  }));
}

/**
 * Grandfathered names no longer on disk.
 *
 * An exemption that outlives its file is a claim about the tree that has
 * stopped being true, and the next reader has no way to know it. If one of
 * these is genuinely gone, its entry comes out of GRANDFATHERED in the same
 * change.
 */
export function staleExemptions(filenames, exempt = GRANDFATHERED) {
  const onDisk = new Set(filenames);
  return exempt.filter((f) => !onDisk.has(f));
}

export function sqlFilesIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  const files = sqlFilesIn(MIGRATIONS_DIR);
  const problems = [];

  for (const group of offendingDuplicates(files)) {
    if (group.unexempt.length === 0) continue;
    problems.push(
      `  ordinal ${group.ordinal} is claimed by ${group.files.length} files:\n` +
        group.files
          .map(
            (f) =>
              `    ${f}${GRANDFATHERED.includes(f) ? "  (grandfathered)" : "  <-- new"}`,
          )
          .join("\n"),
    );
  }

  for (const f of unprefixed(files)) {
    problems.push(
      `  ${f} has no NNNN_ prefix, so migrate() cannot order it by intent.`,
    );
  }

  for (const f of staleExemptions(files)) {
    problems.push(
      `  ${f} is grandfathered in check-ch-migration-ordinals.mjs but is not on disk.\n` +
        "    Remove its GRANDFATHERED entry in the same change that removed the file.",
    );
  }

  if (problems.length > 0) {
    console.error(
      "check-ch-migration-ordinals: ClickHouse migration ordinals are not unique.\n\n" +
        problems.join("\n\n") +
        "\n\n" +
        "migrate() orders migrations/*.sql by sorting the full filename, so two\n" +
        "files under one ordinal run in whatever order their text happens to give.\n" +
        "Give the new file the next free ordinal. Do NOT rename a migration that\n" +
        "has shipped: `_migrations.filename` is the ledger's key, so a rename makes\n" +
        "the file unrecorded and it runs again on every existing deployment.\n",
    );
    process.exit(1);
  }

  console.log(
    `check-ch-migration-ordinals: ${files.length} migration(s), ordinals unique ` +
      `(${GRANDFATHERED.length} grandfathered).`,
  );
}
