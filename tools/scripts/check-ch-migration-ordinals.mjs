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
import { readFileSync, readdirSync } from "node:fs";
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

/**
 * The pre-ledger baseline cutover, copied from `PRE_LEDGER_BASELINE_CUTOVER`
 * in packages/telemetry/src/migrate.ts, and the complete filename of every
 * migration that has shipped as of this guard.
 *
 * WHAT THE BASELINE DOES
 *   On a pre-ledger deployment's first ledger-aware run, `migrateOnce()` takes
 *   every `migrations/*.sql` at or below the cutover and RECORDS it in
 *   `_migrations` without executing it. That is correct for the files the
 *   cutover's author was looking at: those have already run, repeatedly, under
 *   the old replay-everything semantics, and re-running them replays 0021's
 *   `DROP TABLE schema_conformance_events`.
 *
 *   It is wrong for any file that arrives LATER under a low ordinal. The
 *   migrations directory has holes in it — 0001 and 0018 are unused — and a
 *   new `0018_new_table.sql` is four digits wide, collides with nothing, and
 *   sorts exactly where its ordinal claims. Every other check in this file
 *   passes it. The baseline then swallows it: recorded as applied, never
 *   executed, its table absent for ever with nothing saying why. That is
 *   recording-without-executing — the defect this guard's own PR exists to end
 *   — reached through a filename rather than through a ledger state
 *   (Codex, #3192 r4036723001).
 *
 * WHY A RECORDED ROSTER AND NOT A DIFF
 *   The question is whether a file is NEW, and a check reading only the working
 *   tree cannot tell a new `0018` from one that has been there for a year. A
 *   diff against the merge base could, where the merge base is fetched — and
 *   silently degrades to no check at all in a shallow clone, a tag build, or a
 *   local run on a detached HEAD, which is the worst property a guard can have.
 *   So newness is recorded instead of inferred.
 *
 * WHY WHOLE FILENAMES AND NOT ORDINALS
 *   The first version of this roster recorded ORDINALS, reasoning that a
 *   filename roster would need editing whenever a shipped migration is renamed
 *   — which GRANDFATHERED above spends forty lines explaining nobody may do.
 *   That is the argument FOR freezing the names. An invariant nobody may
 *   violate is precisely the one to enforce mechanically, because "nobody may"
 *   is a comment, and this entire PR exists because a comment was doing a
 *   check's job one layer up.
 *
 *   The hole it left, caught by Codex on #3192 (r4036898062): rename a unique
 *   migration and keep its ordinal.
 *   `0021_schema_conformance_events_idempotency.sql` ->
 *   `0021_anything_else.sql` collides with nothing, vacates no ordinal, and
 *   leaves no stale exemption, so an ordinal roster sees nothing at all.
 *   `_migrations.filename` is the ledger's ONLY key, so every deployment that
 *   recorded the old name reads the new one as unapplied and runs it — and
 *   0021 is the DROP+RECREATE of schema_conformance_events, so that replay
 *   destroys retained data on exactly the deployments that have some.
 *
 * WHY THE WHOLE DIRECTORY AND NOT ONLY THE BASELINED HALF
 *   The ledger keys on filename for EVERY migration, not only the ones the
 *   baseline sweeps, so the rename hazard does not stop at the cutover.
 *   0027_tacho_events.sql is above the cutover and is frozen here for the same
 *   reason as the other 26.
 *
 * WHAT THIS DOES NOT FREEZE, AND WHY THAT IS THE TRADE
 *   The roster is a snapshot of what has shipped, and it does not grow. A
 *   migration added after this line was written is absent from it, so renaming
 *   THAT file is invisible here — while the ledger keys on its name just the
 *   same. Closing the residual means appending to this constant in every
 *   migration PR, which is the friction the "an ordinary migration touches no
 *   constant" property buys. The trade is recorded rather than hidden: a test
 *   asserts the residual exists, so nobody reads this roster as covering more
 *   than it does. #3201 carries the decision.
 */
export const PRE_LEDGER_BASELINE_CUTOVER = "0026_stella_operational_events.sql";

export const SHIPPED_MIGRATIONS = Object.freeze([
  "0002_observability.sql",
  "0003_iam_audit.sql",
  "0004_execution_logs_step_nullable.sql",
  "0005_session_telemetry.sql",
  "0006_claude_telemetry.sql",
  "0007_claude_sessions.sql",
  "0008_skill_loads.sql",
  "0009_perf_optimizations.sql",
  "0010_drop_dead_tables.sql",
  "0011_codecs_lowcardinality.sql",
  "0012_token_usage_execution_step_id_nil_uuid.sql",
  "0013_graph_observed_labels.sql",
  "0014_schema_conformance_events.sql",
  "0015_otel_trace_ids.sql",
  "0016_memory_changes.sql",
  "0017_memory_changes_enforcement.sql",
  "0019_usage_events.sql",
  "0020_error_events.sql",
  "0020_eval_item_results.sql",
  "0021_schema_conformance_events_idempotency.sql",
  "0022_error_events_execution_id.sql",
  "0023_principal_attribution.sql",
  "0024_sandbox_log_events.sql",
  "0025_router_outcomes.sql",
  "0026_cache_write_tokens.sql",
  "0026_stella_operational_events.sql",
  "0027_tacho_events.sql",
  "0028_tacho_observed_changes.sql",
  "0029_durable_token_usage.sql",
]);

/** packages/telemetry/src/migrate.ts — the file the cutover above is copied from. */
export const MIGRATE_TS = join(
  repoRoot,
  "packages",
  "telemetry",
  "src",
  "migrate.ts",
);

/**
 * The ordinal the baseline reaches: everything at or below it is swept into
 * the ledger unexecuted on a pre-ledger bootstrap, so a new migration must
 * sort above it.
 */
export function baselineOrdinalFloor(cutover = PRE_LEDGER_BASELINE_CUTOVER) {
  return ordinalOf(cutover);
}

/**
 * Shipped migrations no longer on disk under the name the ledger recorded
 * them by, as `{ was, now }`.
 *
 * `now` is the file that has taken the vacated ordinal, when there is exactly
 * one candidate and it is not itself frozen — the ordinary rename-in-place,
 * which is the shape no other check in this file can see. Otherwise `now` is
 * null: the file was deleted, or renamed onto a different ordinal, and the
 * guard declines to invent a correspondence it cannot observe. Every case
 * carries the same consequence for `_migrations`, so every case is reported;
 * naming the new file when it is knowable is what makes the message
 * actionable rather than merely alarming.
 *
 * @param {readonly string[]} filenames
 * @param {readonly string[]} [frozen]
 * @returns {{ was: string, now: string | null }[]}
 */
export function shippedRenames(filenames, frozen = SHIPPED_MIGRATIONS) {
  const onDisk = new Set(filenames);
  const frozenSet = new Set(frozen);
  return frozen
    .filter((f) => !onDisk.has(f))
    .map((was) => {
      const ordinal = ordinalOf(was);
      const candidates = filenames.filter(
        (f) => ordinalOf(f) === ordinal && !frozenSet.has(f),
      );
      return { was, now: candidates.length === 1 ? candidates[0] : null };
    });
}

/**
 * Files claiming an ordinal at or below the floor that the shipped roster does
 * not name — i.e. files the pre-ledger baseline would record without
 * executing, having never been part of what it was pinned against.
 *
 * A file that is really a RENAME of a frozen migration is excluded here: it
 * fits this description too, but `shippedRenames` reports it with both names
 * and with the consequence that actually applies to it, and one act should
 * produce one report.
 *
 * Returned as `{ file, ordinal }` so the report can name both: the ordinal is
 * what makes it wrong and the filename is what has to change.
 *
 * @param {readonly string[]} filenames
 * @param {readonly string[]} [frozen]
 * @param {string} [cutover]
 * @returns {{ file: string, ordinal: string }[]}
 */
export function baselineBackfills(
  filenames,
  frozen = SHIPPED_MIGRATIONS,
  cutover = PRE_LEDGER_BASELINE_CUTOVER,
) {
  const floor = Number(baselineOrdinalFloor(cutover));
  const shipped = new Set(frozen);
  const renamedTo = new Set(
    shippedRenames(filenames, frozen)
      .map((r) => r.now)
      .filter((n) => n !== null),
  );
  return filenames
    .map((file) => ({ file, ordinal: ordinalOf(file) }))
    .filter(
      ({ file, ordinal }) =>
        ordinal !== null &&
        Number(ordinal) <= floor &&
        !shipped.has(file) &&
        !renamedTo.has(file),
    )
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** The `PRE_LEDGER_BASELINE_CUTOVER` literal in migrate.ts source, or null. */
export function readCutover(source) {
  const m = /PRE_LEDGER_BASELINE_CUTOVER\s*=\s*"([^"]+)"/.exec(source);
  return m ? m[1] : null;
}

/**
 * Disagreement between the cutover recorded here and the one migrate.ts uses,
 * or null when they match.
 *
 * The floor above is only as good as that agreement. migrate.ts documents the
 * cutover as a one-time marker that must never be bumped — "do NOT bump this
 * constant when adding a new migration file" — and until now that was a
 * comment. Bumping it to 0027 would widen what the baseline swallows while
 * this guard went on checking the old width, which is the same silence one
 * layer up. Reading the literal makes the comment enforceable.
 */
export function cutoverDrift(source, expected = PRE_LEDGER_BASELINE_CUTOVER) {
  const found = readCutover(source);
  return found === expected ? null : { found, expected };
}

/**
 * The ordinal width every migration uses, and the reason the width is fixed.
 *
 * `migrate()` applies files in `readdirSync(dir).sort()` order — a plain
 * lexicographic sort of the whole filename. Lexicographic order equals NUMERIC
 * order only while every ordinal has the same number of digits. Drop a digit
 * and the two part company: `27_extension.sql` sorts AFTER `0028_later.sql`,
 * because '2' sorts after '0', so a file calling itself 27 would apply last.
 *
 * That is also why a short prefix is not merely untidy: `"27"` and `"0027"` are
 * different strings, so grouping by the captured text would not see
 * `27_extension.sql` as a second file under 0027 either. It would pass this
 * guard on both counts while being wrong on both — caught by Codex on #3192.
 *
 * So four digits are required rather than normalised. Normalising would group
 * the ordinals correctly and leave the apply order still wrong, which is the
 * half-fix that reads as a fix.
 */
const ORDINAL_DIGITS = 4;
const ORDINAL_RE = new RegExp(`^(\\d{${ORDINAL_DIGITS}})_`);

/**
 * The leading ordinal, or null for a filename that does not carry one in the
 * exact fixed-width form. Anything null is reported by `malformed` below.
 */
export function ordinalOf(filename) {
  const m = ORDINAL_RE.exec(filename);
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

/**
 * `.sql` files that do not carry an ordinal in the exact `NNNN_` form — no
 * digits at all, too few, too many, or not followed by an underscore.
 */
export function malformed(filenames) {
  return filenames.filter((f) => ordinalOf(f) === null).sort();
}

/**
 * The invariant the whole guard exists to protect, asserted directly rather
 * than through the fixed-width rule that implies it: the order `migrate()`
 * applies these files in must be the order their ordinals ask for.
 *
 * Returns the pairs where the two disagree. Files with no valid ordinal are
 * excluded — `malformed` reports those, and including them here would say the
 * same thing twice.
 *
 * Checking the property and not only its proxy matters because the proxy could
 * be replaced by a looser one later and this would still fail. `readOrdinal` is
 * injectable for exactly that reason: with the strict width rule in place this
 * function can never report anything, which would make it an assertion nobody
 * could falsify. A test injects the old loose rule and watches it catch the
 * inversion that rule allowed, so the check is demonstrated rather than assumed.
 */
export function sortOrderConflicts(filenames, readOrdinal = ordinalOf) {
  const ordered = filenames.filter((f) => readOrdinal(f) !== null);
  const byName = [...ordered].sort();
  const byOrdinal = [...ordered].sort((a, b) => {
    const d = Number(readOrdinal(a)) - Number(readOrdinal(b));
    return d !== 0 ? d : a.localeCompare(b);
  });
  const conflicts = [];
  for (let i = 0; i < byName.length; i++) {
    if (byName[i] !== byOrdinal[i]) {
      conflicts.push({
        position: i,
        applied: byName[i],
        expected: byOrdinal[i],
      });
    }
  }
  return conflicts;
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

/**
 * Directory entries that look like a migration but that BOTH this guard and
 * `migrate()` skip, because both filter on a lowercase `.sql` suffix.
 *
 * `0029_thing.SQL` is the shape: it carries a well-formed ordinal, it reads as
 * a migration to anyone looking at the directory, and it never runs. Nothing
 * fails, nothing is logged, and the table it was supposed to create is simply
 * absent — the same silence as the ledger defect this PR is about, arriving by
 * a different route. This guard is the only thing positioned to notice, since
 * by construction the runner cannot.
 */
export function overlooked(entries) {
  return entries
    .filter((f) => !f.endsWith(".sql") && /^\d+[_-].*\.sql$/i.test(f))
    .sort();
}

/** Every entry in the migrations directory, `.sql` or not. */
export function allEntriesIn(dir) {
  return readdirSync(dir).sort();
}

export function sqlFilesIn(dir) {
  return allEntriesIn(dir).filter((f) => f.endsWith(".sql"));
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  const entries = allEntriesIn(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith(".sql"));
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

  for (const f of malformed(files)) {
    problems.push(
      `  ${f} does not carry a ${ORDINAL_DIGITS}-digit NNNN_ ordinal.\n` +
        "    migrate() sorts whole filenames, so an ordinal of any other width\n" +
        "    applies in the wrong place: 27_x.sql runs AFTER 0028_y.sql.",
    );
  }

  for (const c of sortOrderConflicts(files)) {
    problems.push(
      `  apply order disagrees with ordinal order at position ${c.position}:\n` +
        `    migrate() would apply  ${c.applied}\n` +
        `    the ordinals ask for   ${c.expected}`,
    );
  }

  for (const f of overlooked(entries)) {
    problems.push(
      `  ${f} is named like a migration but does not end in a lowercase .sql,\n` +
        "    so migrate() skips it silently and it never runs. Rename the\n" +
        "    extension to .sql, or remove the file.",
    );
  }

  for (const { file, ordinal } of baselineBackfills(files)) {
    problems.push(
      `  ${file} claims ordinal ${ordinal}, at or below the pre-ledger baseline\n` +
        `    cutover (${PRE_LEDGER_BASELINE_CUTOVER}).\n` +
        "    On a pre-ledger deployment's first ledger-aware run, migrate() records\n" +
        "    every file at or below the cutover in _migrations WITHOUT executing it.\n" +
        "    This file was not there when the cutover was pinned, so it would be\n" +
        "    recorded as applied and its statements would never run — on exactly the\n" +
        "    deployments that already have data. Give it the next ordinal above the\n" +
        "    cutover instead; the gaps below it are not free space.",
    );
  }

  for (const { was, now } of shippedRenames(files)) {
    problems.push(
      now === null
        ? `  ${was} has shipped but is no longer on disk under that name, and\n` +
            "    nothing has taken its ordinal — it was deleted, or renamed onto a\n" +
            "    different ordinal.\n" +
            "    `_migrations.filename` is the ledger's only key. Every deployment that\n" +
            "    recorded this name keeps the row for a file that no longer exists, and\n" +
            "    anything standing in for it runs again from its first statement.\n" +
            "    Restore the name. If the file is genuinely retired, remove it from\n" +
            "    SHIPPED_MIGRATIONS in the same change and say why."
        : `  ${was}\n` +
            `    has been renamed to ${now}.\n` +
            "    `_migrations.filename` is the ledger's only key, so every deployment\n" +
            "    that recorded the old name reads the new one as UNAPPLIED and runs it\n" +
            "    again — on 0021 that is DROP TABLE schema_conformance_events, against\n" +
            "    the deployments that hold data. Renaming a shipped migration is never\n" +
            "    safe; restore the original filename.",
    );
  }

  const drift = cutoverDrift(readFileSync(MIGRATE_TS, "utf8"));
  if (drift !== null) {
    problems.push(
      `  PRE_LEDGER_BASELINE_CUTOVER in packages/telemetry/src/migrate.ts reads\n` +
        `    ${drift.found === null ? "(not found)" : drift.found}\n` +
        `    but this guard is written against ${drift.expected}.\n` +
        "    The cutover is a one-time marker for the pre-ledger backlog, not a\n" +
        "    pointer at the latest migration, and moving it widens what the baseline\n" +
        "    records without executing. If the move is deliberate, update\n" +
        "    PRE_LEDGER_BASELINE_CUTOVER and SHIPPED_MIGRATIONS here together.",
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
      "check-ch-migration-ordinals: the ClickHouse migrations directory would not\nrun the way its filenames claim.\n\n" +
        problems.join("\n\n") +
        "\n\n" +
        "migrate() orders migrations/*.sql by sorting the full filename, so two\n" +
        "files under one ordinal run in whatever order their text happens to give.\n" +
        `Give the new file the next free ordinal, ${ORDINAL_DIGITS} digits wide, ABOVE\n` +
        `the pre-ledger cutover (${PRE_LEDGER_BASELINE_CUTOVER}) — the gaps below it\n` +
        "are not free space. Do NOT rename a migration that has shipped:\n" +
        "`_migrations.filename` is the ledger's key, so a rename makes the file\n" +
        "unrecorded and it runs again on every existing deployment.\n",
    );
    process.exit(1);
  }

  console.log(
    `check-ch-migration-ordinals: ${files.length} migration(s), ordinals unique ` +
      `(${GRANDFATHERED.length} grandfathered), none at or below the pre-ledger ` +
      `baseline cutover ${PRE_LEDGER_BASELINE_CUTOVER}, all ` +
      `${SHIPPED_MIGRATIONS.length} shipped filenames unchanged.`,
  );
}
