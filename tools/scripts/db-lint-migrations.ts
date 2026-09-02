#!/usr/bin/env tsx
/**
 * Static lint for both Postgres migration folders. Runs in CI's `checks` job
 * (no DB connection) so structural mistakes are caught before a migrate ever
 * runs.
 *
 * `main()` lints packages/database/drizzle — the pre-Atlas ordinal series. No
 * runner applies it any more (Atlas owns Postgres), so this is a freeze guard:
 * the numbering must stay coherent because the files are still the historical
 * record the baseline snapshot was cut from.
 *
 *  1. Every file is named `NNNN_snake_case_description.sql` (4-digit ordinal).
 *  2. No duplicate ordinals — every migration owns a unique number.
 *  3. No gaps in the ordinal sequence, apart from the squashed range below.
 *
 * `lintAtlas()` lints the LIVE dir, packages/database/atlas/migrations — see
 * its own docblock.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, "..", "..", "..");
const MIGRATIONS_DIR = join(ROOT, "packages/database/drizzle");
const ATLAS_DIR = join(ROOT, "packages/database/atlas/migrations");

const NAME_RE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/**
 * Ordinals permitted to appear more than once. Empty: the folder is clean and
 * every ordinal is unique. A duplicate is always a bug — pick the next free
 * number instead. (Kept as an explicit escape hatch only for a genuinely
 * unrenameable already-shipped collision, per engineering policy §5.)
 */
const FROZEN_DUPLICATE_ORDINALS = new Set<number>();

/** Format an ordinal the way the filenames do: zero-padded to four digits. */
function pad4(ordinal: number): string {
  return String(ordinal).padStart(4, "0");
}

/**
 * Ordinals that were squashed into the 0000_baseline.sql snapshot and will
 * therefore never appear as individual files. These represent migrations from
 * the initial development phase (0011–0027) that were consolidated into the
 * baseline re-stamp and archived under packages/database/drizzle/migration_archive/.
 * Migrations 0001–0010 exist as individual files; 0028+ continue from there.
 */
const SQUASHED_ORDINALS = new Set<number>(
  Array.from({ length: 17 }, (_, i) => i + 11), // 11..27 inclusive
);

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const errors: string[] = [];
  const byOrdinal = new Map<number, string[]>();

  for (const file of files) {
    const match = NAME_RE.exec(file);
    if (!match) {
      errors.push(`${file}: name must match NNNN_snake_case_description.sql`);
      continue;
    }
    const ordinal = Number(match[1]);
    const group = byOrdinal.get(ordinal) ?? [];
    group.push(file);
    byOrdinal.set(ordinal, group);
  }

  const ordinals = [...byOrdinal.keys()].sort((a, b) => a - b);

  // Duplicate ordinals — allowed only for the frozen historical set.
  for (const [ordinal, group] of byOrdinal) {
    if (group.length > 1 && !FROZEN_DUPLICATE_ORDINALS.has(ordinal)) {
      errors.push(
        `duplicate ordinal ${pad4(ordinal)}: ${group.join(", ")} — ` +
          `pick the next free ordinal (${pad4((ordinals.at(-1) ?? 0) + 1)}) instead`,
      );
    }
  }

  // Gap detection — the ordinal sequence must be contiguous, accounting for
  // the squashed ordinals (0011–0027) that are permanently absent because they
  // were folded into the 0000_baseline.sql snapshot.
  let expectedOrdinal = 0;
  for (const actual of ordinals) {
    while (expectedOrdinal < actual) {
      if (!SQUASHED_ORDINALS.has(expectedOrdinal)) {
        errors.push(
          `gap in ordinal sequence: expected ${pad4(expectedOrdinal)}, found ${pad4(actual)}`,
        );
        break;
      }
      expectedOrdinal++;
    }
    if (errors.length > 0) break;
    expectedOrdinal = actual + 1;
  }

  if (errors.length > 0) {
    console.error(kleur.red().bold("[db:lint-migrations] FAIL"));
    for (const e of errors) console.error(kleur.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const next = pad4((ordinals.at(-1) ?? -1) + 1);
  console.log(
    kleur.green(
      `[db:lint-migrations] ok — ${files.length} files, next ordinal ${next}`,
    ),
  );
}

/**
 * Lint the LIVE Atlas migration dir (packages/database/atlas/migrations).
 * Atlas keys applied revisions by the numeric timestamp prefix, so two files
 * sharing a prefix means whichever applies first wins and the other is
 * SILENTLY SKIPPED (2026-07-04: three parallel branches all picked
 * 20260704120000 and broke main). atlas.sum drift (entries not matching the
 * files on disk) breaks `atlas migrate apply` with a checksum error — and a
 * GitHub merge can splice stale entries even when both sides validated
 * independently. Both failure modes must die in CI's `checks` job, before any
 * migrate runs.
 */
const ATLAS_NAME_RE = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

function lintAtlas(): void {
  const files = readdirSync(ATLAS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const errors: string[] = [];
  const byVersion = new Map<string, string[]>();

  for (const file of files) {
    const match = ATLAS_NAME_RE.exec(file);
    if (!match) {
      errors.push(
        `${file}: name must match YYYYMMDDHHMMSS_snake_case_description.sql`,
      );
      continue;
    }
    const version = match[1]!;
    const group = byVersion.get(version) ?? [];
    group.push(file);
    byVersion.set(version, group);
  }

  for (const [version, group] of byVersion) {
    if (group.length > 1) {
      errors.push(
        `duplicate atlas version ${version}: ${group.join(", ")} — atlas keys revisions by ` +
          `this prefix and silently skips the loser; rename one to a later, unclaimed timestamp ` +
          `and re-run \`atlas migrate hash\``,
      );
    }
  }

  // atlas.sum consistency: one entry per file, no stale/extra entries. The sum
  // hash itself is atlas's job (`atlas migrate validate` in CI); this guard
  // catches the merge-splice shape (entry/file drift) without needing the CLI.
  const sumEntries = readFileSync(join(ATLAS_DIR, "atlas.sum"), "utf8")
    .split("\n")
    .map((line) => /^(\S+\.sql)\s+h1:/.exec(line)?.[1])
    .filter((f): f is string => Boolean(f));
  const fileSet = new Set(files);
  const sumSet = new Set(sumEntries);
  if (sumEntries.length !== sumSet.size) {
    errors.push(
      `atlas.sum lists a file more than once — regenerate with \`atlas migrate hash\``,
    );
  }
  for (const f of files) {
    if (!sumSet.has(f))
      errors.push(`${f} missing from atlas.sum — run \`atlas migrate hash\``);
  }
  for (const s of sumSet) {
    if (!fileSet.has(s)) {
      errors.push(
        `atlas.sum lists ${s} which does not exist on disk (stale/spliced entry) — run \`atlas migrate hash\``,
      );
    }
  }

  if (errors.length > 0) {
    console.error(kleur.red().bold("[db:lint-migrations] FAIL (atlas)"));
    for (const e of errors) console.error(kleur.red(`  ✗ ${e}`));
    process.exit(1);
  }

  console.log(
    kleur.green(
      `[db:lint-migrations] atlas ok — ${files.length} files, ${sumSet.size} sum entries, no duplicate versions`,
    ),
  );
}

main();
lintAtlas();
