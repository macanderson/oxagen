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
 * `lintAtlas()` lints the LIVE dir, packages/database/atlas/migrations (see
 * its own docblock). `checkAtlasBaseline()` is the git-aware half of that
 * lint (see its own docblock for why the filesystem-only checks above it
 * cannot catch a migration stamped behind the branch it merges into, #3387).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, "..", "..", "..");
const MIGRATIONS_DIR = join(ROOT, "packages/database/drizzle");
const ATLAS_DIR = join(ROOT, "packages/database/atlas/migrations");
const ATLAS_MIGRATIONS_REL = "packages/database/atlas/migrations";

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

/** The 14-digit version prefix, or null for a name `ATLAS_NAME_RE` rejects. */
export function atlasVersionOf(file: string): string | null {
  const m = ATLAS_NAME_RE.exec(file);
  return m ? m[1]! : null;
}

/** The highest version prefix among `files`, or null if none is well-formed. */
export function maxAtlasVersion(files: readonly string[]): string | null {
  let max: string | null = null;
  for (const f of files) {
    const v = atlasVersionOf(f);
    if (v !== null && (max === null || v > max)) max = v;
  }
  return max;
}

/** Runs a git subcommand from the repo root and returns its stdout. */
export type GitRunner = (args: string[]) => string;

export function defaultGitRunner(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/**
 * The merge base of `headRef` and `baseRef`, or null when git cannot answer:
 * a shallow clone, a tarball checkout with no `.git`, or a `baseRef` that was
 * never fetched. Never throws.
 */
export function mergeBaseOf(
  headRef: string,
  baseRef: string,
  run: GitRunner = defaultGitRunner,
): string | null {
  try {
    return run(["merge-base", headRef, baseRef]).trim();
  } catch {
    return null;
  }
}

/**
 * The `.sql` filenames in the Atlas migrations directory AT `ref`, read from
 * git's object store rather than the working tree, so it answers what the
 * directory looked like at a past commit, not just what is checked out now.
 * Null when `ref` cannot be read (git unavailable, or the path did not exist
 * at that commit). Never throws.
 */
export function atlasFilesAtRef(
  ref: string,
  run: GitRunner = defaultGitRunner,
): string[] | null {
  try {
    const out = run([
      "ls-tree",
      "--name-only",
      `${ref}:${ATLAS_MIGRATIONS_REL}`,
    ]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((f) => f.endsWith(".sql"));
  } catch {
    return null;
  }
}

/** Match exact working-tree bytes at this path against merge-base ancestors. */
function isExactHistoricalRestoration(
  file: string,
  mergeBase: string,
  run: GitRunner,
): boolean {
  const path = `${ATLAS_MIGRATIONS_REL}/${file}`;
  try {
    const currentBlob = run(["hash-object", "--no-filters", "--", path]).trim();
    if (!/^[0-9a-f]{40,64}$/.test(currentBlob)) return false;
    const commits = run([
      "log",
      "--format=%H",
      "--full-history",
      mergeBase,
      "--",
      path,
    ])
      .split("\n")
      .filter((commit) => /^[0-9a-f]{40,64}$/.test(commit));
    for (const commit of commits) {
      try {
        if (
          run([
            "rev-parse",
            "--verify",
            "--quiet",
            `${commit}:${path}`,
          ]).trim() === currentBlob
        )
          return true;
      } catch {
        // A deletion commit has no blob at this path. Check earlier ancestors.
      }
    }
  } catch {
    // Missing history or unreadable working bytes cannot authorize an exception.
  }
  return false;
}

export interface AtlasBaselineResult {
  /** "degraded" means git could not establish a baseline (see `note`). */
  status: "ok" | "degraded";
  errors: string[];
  warnings: string[];
  note?: string;
}

/**
 * The git-aware half of the Atlas lint (#3387): every migration a branch adds
 * relative to its merge base with the default branch must sort AFTER the
 * highest version already in that merge base.
 *
 * WHY THE FILENAME/COLLISION CHECKS ABOVE CANNOT CATCH THIS
 *   `lintAtlas()`'s duplicate-prefix and atlas.sum checks are filesystem-only:
 *   they know what is on disk right now and nothing about history. A migration
 *   stamped behind the branch it will merge into collides with nothing and
 *   drifts from nothing, so it passes both checks silently. Atlas keys
 *   applied revisions by the version prefix, so a database that already
 *   applied the later revisions never applies this one at all (#3387, the real
 *   case: PR #3337 stamped a migration 20260918161000 while the branch's merge
 *   base already carried migrations up to 20260918200000).
 *
 * TWO COMPARISONS, TWO SEVERITIES
 *   - Against the MERGE BASE: fails. A migration stamped at or before the
 *     merge base's own maximum was wrong the moment it was written. Nothing
 *     that has happened to the default branch since is responsible for that.
 *   - Against the default branch's CURRENT tip: warns. The default branch
 *     moves under a long-lived PR, so a migration that cleared its merge base
 *     can still fall behind by the time it merges. That is not an authoring
 *     mistake, and blocking it would punish branch age rather than the defect
 *     this check exists for; the merge-base comparison already caught that.
 *
 * An exact restoration is the one exception: the working bytes must match a
 * blob at the same path in history reachable from the merge base. Branch-only
 * history, renamed paths, and edited historical SQL do not qualify. Restoring
 * a file does not prove that a deployed database applied that revision.
 *
 * "ADDED" IS A FILE-SET DIFF, NOT A LINE DIFF
 *   `currentFiles` (the working tree) is compared against the merge base's
 *   file SET, not against a line-oriented diff of the two. A migration a
 *   rebase or a merge carries forward unchanged is in both sets and is never
 *   reported, no matter what the diff between the two commits looks like.
 *
 * DEGRADING HONESTLY
 *   `mergeBaseOf` and `atlasFilesAtRef` never throw; a git failure (shallow
 *   clone, tarball checkout, an unfetched `baseRef`) returns `status:
 *   "degraded"` with a `note` explaining why the ordering check did not run.
 *   The caller prints that note rather than staying silent: a shallow clone
 *   must never read as "ordering verified".
 *
 * WHY THE HEAD REF IS NOT ALWAYS LITERALLY "HEAD"
 *   `actions/checkout` on a `pull_request` event checks out GitHub's synthetic
 *   merge ref (`refs/pull/N/merge`) by default, so `HEAD` in CI is a merge
 *   commit whose parents are the PR's real tip and the base branch's tip at
 *   that moment, not the PR branch itself. `origin/main` is an ancestor of
 *   that merge commit, so `git merge-base HEAD origin/main` degenerates to
 *   `origin/main`'s current tip rather than the branch's real divergence
 *   point, collapsing the two-tier fail/warn distinction above into one tier:
 *   every added migration would be compared only against the moving target
 *   the WARN case exists to protect against. `DB_LINT_HEAD_REF` (defaulting
 *   to `HEAD` when unset) lets CI pass the PR's actual head SHA
 *   (`github.event.pull_request.head.sha`) instead.
 *
 * Needs no database connection: `git merge-base` plus two `git ls-tree`
 * listings, so this stays in the DB-less `checks` CI job.
 */
export function checkAtlasBaseline(
  currentFiles: readonly string[],
  opts: { headRef?: string; baseRef?: string; run?: GitRunner } = {},
): AtlasBaselineResult {
  // `|| "HEAD"`, not `??`: on a push event the workflow step still sets
  // DB_LINT_HEAD_REF (to github.event.pull_request.head.sha, which GitHub
  // Actions expands to an empty string outside a pull_request event), and an
  // empty string is not the caller's request for a different ref.
  const headRef = opts.headRef ?? (process.env.DB_LINT_HEAD_REF || "HEAD");
  const baseRef = opts.baseRef ?? process.env.DB_LINT_BASE_REF ?? "origin/main";
  const run = opts.run ?? defaultGitRunner;

  const mergeBase = mergeBaseOf(headRef, baseRef, run);
  if (mergeBase === null) {
    return {
      status: "degraded",
      errors: [],
      warnings: [],
      note:
        `could not establish a git baseline (\`git merge-base ${headRef} ${baseRef}\` ` +
        "failed). The merge-base ordering check above did NOT run. This is expected " +
        "in a shallow clone or a tarball checkout, and is not the same as passing: " +
        "fetch full history (`git fetch --unshallow`, or CI's `fetch-depth: 0`) before " +
        "trusting a new migration's timestamp ordering.",
    };
  }

  const mergeBaseFiles = atlasFilesAtRef(mergeBase, run);
  if (mergeBaseFiles === null) {
    return {
      status: "degraded",
      errors: [],
      warnings: [],
      note:
        `could not read the atlas migrations tree at merge base ${mergeBase}. ` +
        "The ordering check above did NOT run.",
    };
  }

  const mergeBaseSet = new Set(mergeBaseFiles);
  const addedFiles = currentFiles.filter((f) => !mergeBaseSet.has(f));
  const mergeBaseMax = maxAtlasVersion(mergeBaseFiles);

  const headFiles = atlasFilesAtRef(baseRef, run);
  const headMax = headFiles !== null ? maxAtlasVersion(headFiles) : null;

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const file of addedFiles) {
    const version = atlasVersionOf(file);
    if (version === null) continue; // malformed name: lintAtlas() reports it

    if (mergeBaseMax !== null && version <= mergeBaseMax) {
      if (isExactHistoricalRestoration(file, mergeBase, run)) {
        warnings.push(
          `${file}: exact historical restoration from merge-base ancestry. ` +
            "Preserve its revision name and verify deployed Atlas history before application. " +
            "This check does not prove that a database applied the restored revision.",
        );
        continue;
      }
      errors.push(
        `${file}: stamped ${version}, at or before ${mergeBaseMax}, the latest ` +
          `migration already on ${baseRef} where this branch diverged (merge base ` +
          `${mergeBase.slice(0, 12)}). Atlas keys applied revisions by this prefix, so ` +
          "a database that already applied the merge-base migrations would silently " +
          "skip this one forever. Rename it to a later, unclaimed timestamp and " +
          'regenerate the checksum: `atlas migrate hash --dir "file://atlas/migrations"` ' +
          "from packages/database.",
      );
      continue;
    }

    if (headMax !== null && version <= headMax) {
      warnings.push(
        `${file}: stamped ${version}, at or before ${headMax}, the latest migration ` +
          `on ${baseRef} right now. It cleared its merge base, so it was correctly ` +
          `stamped when written; ${baseRef} has since moved past it. Not blocking, but ` +
          "renaming to a later timestamp (and re-running `atlas migrate hash --dir " +
          '"file://atlas/migrations"` from packages/database) avoids relying on merge order.',
      );
    }
  }

  return { status: "ok", errors, warnings };
}

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

  // The ClickHouse migrations directory has the same failure mode and its own
  // guard: tools/scripts/check-ch-migration-ordinals.mjs, run by
  // `check:contracts` on the same CI line as this script.
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

  // Git-aware ordering (#3387). See checkAtlasBaseline()'s own docblock.
  // Filename shape and atlas.sum consistency, checked above, know nothing
  // about history, so neither catches a migration stamped behind the branch
  // it will merge into.
  const baseline = checkAtlasBaseline(files);
  if (baseline.status === "degraded") {
    console.warn(kleur.yellow(`[db:lint-migrations] ⚠ ${baseline.note}`));
  } else {
    errors.push(...baseline.errors);
    for (const w of baseline.warnings) {
      console.warn(kleur.yellow(`[db:lint-migrations] ⚠ ${w}`));
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

// Guarded so a test can import the exported functions above (atlasVersionOf,
// checkAtlasBaseline, and the rest) without running the CLI, which shells
// out to git and calls process.exit(1) on a violation.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main();
  lintAtlas();
}
