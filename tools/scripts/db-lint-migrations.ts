#!/usr/bin/env tsx
/**
 * Static lint for the Postgres migration folder. Runs in CI's `checks` job
 * (no DB connection) so structural mistakes are caught before a migrate ever
 * runs. Enforces the conventions the custom runner (tools/scripts/db-migrate.ts)
 * relies on:
 *
 *  1. Every file is named `NNNN_snake_case_description.sql` (4-digit ordinal).
 *  2. No duplicate ordinals — every migration owns a unique number. (The two
 *     historical 0002/0003 collisions were consolidated/renumbered, so the
 *     folder is clean; this guard keeps it that way.)
 *  3. No gaps in the ordinal sequence (0000, 0001, … contiguous).
 *
 * The custom runner applies files in `readdirSync().sort()` (lexicographic)
 * order and tracks them by filename, so a clean, unique, contiguous ordinal
 * sequence keeps apply-order unambiguous going forward.
 */
import { readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, "..", "..", "..");
const MIGRATIONS_DIR = join(ROOT, "packages/database/drizzle");

const NAME_RE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/**
 * Ordinals permitted to appear more than once. Empty: the folder is clean and
 * every ordinal is unique. A duplicate is always a bug — pick the next free
 * number instead. (Kept as an explicit escape hatch only for a genuinely
 * unrenameable already-shipped collision, per engineering policy §5.)
 */
const FROZEN_DUPLICATE_ORDINALS = new Set<number>();

/**
 * Ordinals that were squashed into the 0000_baseline.sql snapshot and will
 * therefore never appear as individual files. These represent migrations from
 * the initial development phase (0005–0027) that were consolidated into the
 * baseline re-stamp and archived under packages/database/drizzle/migration_archive/.
 * New migrations start at 0028 and proceed sequentially from there.
 */
const SQUASHED_ORDINALS = new Set<number>(
  Array.from({ length: 23 }, (_, i) => i + 5), // 5..27 inclusive
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
        `duplicate ordinal ${String(ordinal).padStart(4, "0")}: ${group.join(", ")} — ` +
          `pick the next free ordinal (${String((ordinals.at(-1) ?? 0) + 1).padStart(4, "0")}) instead`,
      );
    }
  }

  // Gap detection — the ordinal sequence must be contiguous, accounting for
  // squashed ordinals (5–27) that are permanently absent because they were
  // folded into the 0000_baseline.sql snapshot.
  let expectedOrdinal = 0;
  for (const actual of ordinals) {
    while (expectedOrdinal < actual) {
      if (!SQUASHED_ORDINALS.has(expectedOrdinal)) {
        errors.push(
          `gap in ordinal sequence: expected ${String(expectedOrdinal).padStart(4, "0")}, found ${String(actual).padStart(4, "0")}`,
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

  const next = String((ordinals.at(-1) ?? -1) + 1).padStart(4, "0");
  console.log(
    kleur.green(`[db:lint-migrations] ok — ${files.length} files, next ordinal ${next}`),
  );
}

main();
