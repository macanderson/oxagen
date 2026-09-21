/**
 * The guard against a second ClickHouse migration under an ordinal that is
 * already taken.
 *
 * `migrate()` orders `packages/telemetry/src/migrations/*.sql` with
 * `readdirSync(dir).sort()` — a sort of the full filename. Two files under one
 * ordinal therefore run in the order their spelling gives, which is not an
 * order anybody chose, and if the second half depends on the first that decides
 * silently whether a fresh database migrates or fails.
 *
 * Every case below is built from the REAL directory listing rather than from
 * two invented names like `0001_a.sql` / `0002_b.sql`. A test over invented
 * names proves the function can count; it proves nothing about whether the
 * exemption list still matches the tree, which is the part that rots.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GRANDFATHERED,
  MIGRATE_TS,
  MIGRATIONS_DIR,
  PRE_LEDGER_BASELINE_CUTOVER,
  SHIPPED_MIGRATIONS,
  baselineBackfills,
  baselineOrdinalFloor,
  cutoverDrift,
  duplicateOrdinals,
  offendingDuplicates,
  ordinalOf,
  readCutover,
  sqlFilesIn,
  staleExemptions,
  malformed,
  overlooked,
  shippedRenames,
  sortOrderConflicts,
} from "./check-ch-migration-ordinals.mjs";

/** What is actually on disk right now. */
const REAL: string[] = sqlFilesIn(MIGRATIONS_DIR);

function nextMigration(files: string[], stem: string): string {
  const tip = Math.max(0, ...files.map((file) => Number(ordinalOf(file) ?? 0)));
  return `${String(tip + 1).padStart(4, "0")}_${stem}.sql`;
}

describe("the real migrations directory", () => {
  it("is the directory this guard claims to describe", () => {
    // If this ever reads 0, every other assertion below passes vacuously.
    expect(REAL.length).toBeGreaterThan(20);
    expect(REAL).toContain("0021_schema_conformance_events_idempotency.sql");
  });

  it("has exactly the two duplicated ordinals the exemption list names", () => {
    const dupes = duplicateOrdinals(REAL);
    expect(dupes.map((d) => d.ordinal)).toEqual(["0020", "0026"]);
    expect(dupes.flatMap((d) => d.files).sort()).toEqual(
      [...GRANDFATHERED].sort(),
    );
  });

  it("passes the guard as it stands", () => {
    const offending = offendingDuplicates(REAL).filter(
      (g) => g.unexempt.length > 0,
    );
    expect(offending).toEqual([]);
    expect(malformed(REAL)).toEqual([]);
    expect(sortOrderConflicts(REAL)).toEqual([]);
    expect(staleExemptions(REAL)).toEqual([]);
  });

  it("would fail with no exemptions — the duplicates are real, not hypothetical", () => {
    // The witness. Without the grandfather list, today's tree is already in
    // violation; the list is what makes the guard land green, and this is what
    // it is standing in front of.
    const offending = offendingDuplicates(REAL, []).filter(
      (g) => g.unexempt.length > 0,
    );
    expect(offending.map((g) => g.ordinal)).toEqual(["0020", "0026"]);
  });
});

describe("a new duplicate", () => {
  it("is caught when it collides with an ordinal that is free of exemptions", () => {
    // 0021 has one file today. A second one is the plain case.
    const withNew = [...REAL, "0021_something_else.sql"].sort();
    const offending = offendingDuplicates(withNew).filter(
      (g) => g.unexempt.length > 0,
    );
    expect(offending).toHaveLength(1);
    expect(offending[0]!.ordinal).toBe("0021");
    // Neither half of a brand-new duplicate is exempt, so both are named —
    // the reader has to decide which one moves, and the guard does not pick.
    expect(offending[0]!.unexempt).toEqual([
      "0021_schema_conformance_events_idempotency.sql",
      "0021_something_else.sql",
    ]);
  });

  it("is caught when it collides with an ordinal that is ALREADY grandfathered", () => {
    // The case an ordinal-level exemption would wave through: 0020 is a known
    // duplicate, so a guard that exempted the ORDINAL would accept a third file
    // there. The exemption is per filename, so it does not.
    const withNew = [...REAL, "0020_a_third_one.sql"].sort();
    const offending = offendingDuplicates(withNew).filter(
      (g) => g.unexempt.length > 0,
    );
    expect(offending).toHaveLength(1);
    expect(offending[0]!.ordinal).toBe("0020");
    expect(offending[0]!.unexempt).toEqual(["0020_a_third_one.sql"]);
    // The report carries the whole group, so the reader sees what it hit.
    expect(offending[0]!.files).toEqual([
      "0020_a_third_one.sql",
      "0020_error_events.sql",
      "0020_eval_item_results.sql",
    ]);
  });

  it("is caught even when it sorts before both grandfathered halves", () => {
    // `0020_aaa.sql` sorts first in the group. A guard that only looked at the
    // files after the first would miss it.
    const offending = offendingDuplicates([...REAL, "0020_aaa.sql"].sort())
      .filter((g) => g.unexempt.length > 0)
      .flatMap((g) => g.unexempt);
    expect(offending).toEqual(["0020_aaa.sql"]);
  });

  it("is caught as a FIFTH file joining an already-grandfathered group", () => {
    // The shape that would make the exemption list worthless: if exempting
    // 0020's two files quietly exempted the ORDINAL 0020, the list would permit
    // unlimited additions to exactly the ordinals it was meant to freeze. Two
    // more files under 0020 are both reported, and the grandfathered pair is
    // not.
    const withTwoMore = [...REAL, "0020_fourth.sql", "0020_fifth.sql"].sort();
    const offending = offendingDuplicates(withTwoMore).filter(
      (g) => g.unexempt.length > 0,
    );
    expect(offending).toHaveLength(1);
    expect(offending[0]!.files).toHaveLength(4);
    expect(offending[0]!.unexempt).toEqual([
      "0020_fifth.sql",
      "0020_fourth.sql",
    ]);
  });

  it("is NOT reported when it takes the next free ordinal", () => {
    const offending = offendingDuplicates(
      [...REAL, nextMigration(REAL, "brand_new")].sort(),
    ).filter((g) => g.unexempt.length > 0);
    expect(offending).toEqual([]);
  });
});

describe("ordinal width", () => {
  // Codex, #3192 r4036258976. The guard compared the ordinal's REPRESENTATION
  // rather than its value: "27" and "0027" are the same ordinal and different
  // strings, so a short prefix collided with nothing and the runner then
  // ordered it wrongly. Every case here passed the old `/^(\d+)_/` rule.

  it("rejects a short prefix, which the old rule accepted as ordinal 27", () => {
    expect(/^(\d+)_/.exec("27_extension.sql")?.[1]).toBe("27"); // the old rule
    expect(ordinalOf("27_extension.sql")).toBeNull(); // this one
    expect(malformed([...REAL, "27_extension.sql"])).toEqual([
      "27_extension.sql",
    ]);
  });

  it("rejects an over-wide prefix for the same reason", () => {
    expect(/^(\d+)_/.exec("00027_extension.sql")?.[1]).toBe("00027");
    expect(ordinalOf("00027_extension.sql")).toBeNull();
  });

  it("does not let a short prefix pass as a duplicate of the padded ordinal", () => {
    // The first half of the finding: `27_` never collided with `0027_`, so two
    // files could claim ordinal 27 and the duplicate check said nothing. It is
    // reported now — as malformed rather than as a duplicate, because the name
    // is wrong before the collision is.
    const files = [...REAL, "27_extension.sql"].sort();
    expect(
      offendingDuplicates(files).filter((g) => g.unexempt.length > 0),
    ).toEqual([]);
    expect(malformed(files)).toEqual(["27_extension.sql"]);
  });

  it("rejects digits with no separator, and a separator that is not an underscore", () => {
    expect(ordinalOf("0027extension.sql")).toBeNull();
    expect(ordinalOf("0027-extension.sql")).toBeNull();
    expect(malformed([...REAL, "0027extension.sql", "0031-x.sql"])).toEqual([
      "0027extension.sql",
      "0031-x.sql",
    ]);
  });

  it("accepts the four-digit form every file on disk already uses", () => {
    expect(malformed(REAL)).toEqual([]);
    // Including the grandfathered names — requiring four digits must not
    // reject a file nobody is allowed to rename.
    for (const g of GRANDFATHERED) expect(ordinalOf(g)).not.toBeNull();
  });
});

describe("apply order versus ordinal order", () => {
  // The dangerous half of the finding, asserted as the property rather than
  // through the width rule that implies it. If the width rule is ever loosened,
  // this still fails.

  it("agrees for the real directory", () => {
    expect(sortOrderConflicts(REAL)).toEqual([]);
  });

  it("catches the inversion a short prefix causes", () => {
    // '2' sorts after '0', so the file calling itself 27 applies after 0028.
    const files = [...REAL, "0028_later.sql", "27_extension.sql"].sort();
    const bad = sortOrderConflicts(
      files.filter((f) => /^\d+_/.test(f)).map((f) => f),
    );
    // With the strict rule, 27_extension.sql has no ordinal and is excluded
    // here (malformed reports it), so the remaining files are consistent.
    expect(bad).toEqual([]);
    expect(malformed(files)).toEqual(["27_extension.sql"]);
  });

  it("catches the inversion when the width rule is loosened to the old one", () => {
    // With the strict width rule this function can never report anything —
    // four-digit ordinals make lexicographic order and numeric order the same
    // relation. That would leave it an assertion nobody could falsify, so the
    // ordinal reader is injectable and this test supplies the OLD loose rule
    // and watches the inversion it allowed get caught.
    const loose = (f: string) => /^(\d+)_/.exec(f)?.[1] ?? null;
    const files = ["0027_tacho.sql", "0028_later.sql", "27_extension.sql"];

    // The old rule accepts all three, and this is the order migrate() applies
    // them in: the file calling itself 27 runs last.
    expect(files.map(loose)).toEqual(["0027", "0028", "27"]);
    expect([...files].sort()).toEqual([
      "0027_tacho.sql",
      "0028_later.sql",
      "27_extension.sql",
    ]);

    const conflicts = sortOrderConflicts(files, loose);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.position).toBe(1);
    expect(conflicts[0]!.applied).toBe("0028_later.sql");
    expect(conflicts[0]!.expected).toBe("27_extension.sql");
  });

  it("agrees on a padded set spanning a digit boundary", () => {
    // 9 -> 10 -> 100 is where unpadded ordinals would invert, and where the
    // padding earns its keep.
    expect(
      sortOrderConflicts(["0009_nine.sql", "0010_ten.sql", "0100_hundred.sql"]),
    ).toEqual([]);
  });
});

describe("files the runner skips in silence", () => {
  it("reports a migration whose extension is not a lowercase .sql", () => {
    // Both this guard and migrate() filter on `.endsWith(".sql")`, so
    // 0029_thing.SQL is a migration that never runs and never complains. The
    // guard is the only thing positioned to notice, because by construction
    // the runner cannot.
    expect(overlooked([...REAL, "0029_thing.SQL"])).toEqual(["0029_thing.SQL"]);
    expect(overlooked([...REAL, "0030_thing.Sql"])).toEqual(["0030_thing.Sql"]);
  });

  it("does not flag ordinary .sql files or unrelated entries", () => {
    expect(overlooked(REAL)).toEqual([]);
    expect(overlooked([...REAL, "README.md", "notes.txt"])).toEqual([]);
  });
});

describe("exemptions that stop matching the tree", () => {
  it("are reported when a grandfathered file is renamed away", () => {
    // Renaming 0020_eval_item_results.sql to a free ordinal would resolve the
    // duplicate and leave a stale claim behind. The guard says so rather than
    // carrying an exemption for a file nobody can find.
    const renamed = REAL.filter(
      (f) => f !== "0020_eval_item_results.sql",
    ).concat(nextMigration(REAL, "eval_item_results"));
    expect(staleExemptions(renamed)).toEqual(["0020_eval_item_results.sql"]);
  });

  it("are empty for the tree as it stands", () => {
    expect(staleExemptions(REAL)).toEqual([]);
  });
});

describe("ordinalOf", () => {
  it("reads the prefix of a real filename", () => {
    expect(ordinalOf("0021_schema_conformance_events_idempotency.sql")).toBe(
      "0021",
    );
  });

  it("returns null for a file with no ordinal, which the guard reports", () => {
    expect(ordinalOf("schema.sql")).toBeNull();
    expect(malformed([...REAL, "no_ordinal.sql"])).toEqual(["no_ordinal.sql"]);
  });

  it("does not read a number from the middle of a name", () => {
    expect(ordinalOf("error_0020_events.sql")).toBeNull();
  });
});

describe("an ordinal at or below the pre-ledger baseline cutover", () => {
  // Codex, #3192 r4036723001. Every other check in this file asks a question
  // about the NAME — is it four digits, is it unique, does it sort where it
  // claims to. A gap-fill passes all of them: `0018_new_table.sql` is
  // four digits wide, claims a free ordinal, and sorts exactly where its
  // ordinal says. The question those checks do not ask is what the name means
  // relative to the pre-ledger baseline, and that is the one that matters:
  // migrate() sweeps every file at or below PRE_LEDGER_BASELINE_CUTOVER into
  // the ledger WITHOUT executing it on a pre-ledger deployment's first
  // ledger-aware run. A file that did not exist when the cutover was pinned,
  // but whose ordinal falls under it, is recorded as applied and never runs —
  // recording-without-executing, which is the defect this whole PR exists to
  // end, arriving through a filename instead of through a ledger state.

  it("is invisible to every other check in this guard", () => {
    // The witness for why a new rule was needed rather than a tighter old one.
    const withGapFill = [...REAL, "0018_new_table.sql"].sort();
    expect(malformed(withGapFill)).toEqual([]);
    expect(
      offendingDuplicates(withGapFill).filter((g) => g.unexempt.length > 0),
    ).toEqual([]);
    expect(sortOrderConflicts(withGapFill)).toEqual([]);
    expect(overlooked(withGapFill)).toEqual([]);
  });

  it("is rejected when it fills 0018, the gap the finding names", () => {
    expect(baselineBackfills([...REAL, "0018_new_table.sql"].sort())).toEqual([
      { file: "0018_new_table.sql", ordinal: "0018" },
    ]);
  });

  it("is rejected at 0001, the other gap under the cutover", () => {
    expect(baselineBackfills([...REAL, "0001_early.sql"].sort())).toEqual([
      { file: "0001_early.sql", ordinal: "0001" },
    ]);
  });

  it("is rejected below every ordinal that has ever existed", () => {
    // 0000 is under the whole roster rather than inside a gap in it. A rule
    // written as a list of known holes would have to remember to include it;
    // a rule written as "the recorded set of occupied ordinals" gets it free.
    expect(baselineBackfills([...REAL, "0000_zeroth.sql"].sort())).toEqual([
      { file: "0000_zeroth.sql", ordinal: "0000" },
    ]);
  });

  it("is caught for EVERY ordinal at or below the floor, by one check or the other", () => {
    // The rule stated exhaustively rather than by example. For each ordinal
    // from 0000 up to the cutover, a new file claiming it is refused — as a
    // baseline backfill if the ordinal is free, as a duplicate if it is taken.
    // Nothing under the floor is reachable by a new migration.
    const floor = Number(baselineOrdinalFloor());
    const missed: string[] = [];
    for (let n = 0; n <= floor; n++) {
      const ordinal = String(n).padStart(4, "0");
      const candidate = `${ordinal}_new_arrival.sql`;
      const files = [...REAL, candidate].sort();
      const asBackfill = baselineBackfills(files).some(
        (b) => b.file === candidate,
      );
      const asDuplicate = offendingDuplicates(files).some((g) =>
        g.unexempt.includes(candidate),
      );
      if (!asBackfill && !asDuplicate) missed.push(candidate);
    }
    expect(missed).toEqual([]);
  });

  it("accepts the first ordinal above the cutover", () => {
    // The mirror. Without it the rule could pass by refusing everything.
    // A fixture whose highest file IS the cutover, so 0027 is the next one up
    // — on the real tree 0027 is already taken and would be a duplicate,
    // which is a different check answering a different question.
    const upToCutover = REAL.filter((f) => f <= PRE_LEDGER_BASELINE_CUTOVER);
    expect(upToCutover.at(-1)).toBe(PRE_LEDGER_BASELINE_CUTOVER);
    const withNext = [...upToCutover, "0027_something.sql"].sort();
    expect(baselineBackfills(withNext)).toEqual([]);
    expect(
      offendingDuplicates(withNext).filter((g) => g.unexempt.length > 0),
    ).toEqual([]);
    expect(malformed(withNext)).toEqual([]);
    expect(sortOrderConflicts(withNext)).toEqual([]);
  });

  it("accepts the next free ordinal on the real tree", () => {
    expect(
      baselineBackfills([...REAL, nextMigration(REAL, "brand_new")].sort()),
    ).toEqual([]);
    expect(baselineBackfills([...REAL, "0031_much_later.sql"].sort())).toEqual(
      [],
    );
  });

  it("accepts the tree as it stands", () => {
    expect(baselineBackfills(REAL)).toEqual([]);
    expect(shippedRenames(REAL)).toEqual([]);
  });

  it("is not double-reported when it is really a rename", () => {
    // A renamed 0021 is a file at or below the cutover that the roster does
    // not name, so the backfill rule would fire on it too. It is reported
    // once, as a rename, because that is the report that names the actual
    // consequence — the ledger replaying a DROP — and names both filenames.
    const renamed = REAL.filter(
      (f) => f !== "0021_schema_conformance_events_idempotency.sql",
    ).concat("0021_conformance_idempotency.sql");
    expect(baselineBackfills(renamed)).toEqual([]);
    expect(shippedRenames(renamed)).toEqual([
      {
        was: "0021_schema_conformance_events_idempotency.sql",
        now: "0021_conformance_idempotency.sql",
      },
    ]);
  });
});

describe("the cutover this guard is written against", () => {
  // The floor is only as good as its agreement with the constant it describes.
  // PRE_LEDGER_BASELINE_CUTOVER lives in migrate.ts and is documented there as
  // a one-time marker that must never be bumped; this is what makes that
  // documentation enforceable rather than advisory.

  it("is the literal migrate.ts actually uses", () => {
    const source = readFileSync(MIGRATE_TS, "utf8");
    expect(readCutover(source)).toBe(PRE_LEDGER_BASELINE_CUTOVER);
    expect(cutoverDrift(source)).toBeNull();
  });

  it("reports a cutover that has been bumped", () => {
    const moved = `const PRE_LEDGER_BASELINE_CUTOVER = "0027_tacho_events.sql";`;
    expect(cutoverDrift(moved)).toEqual({
      found: "0027_tacho_events.sql",
      expected: PRE_LEDGER_BASELINE_CUTOVER,
    });
  });

  it("reports a cutover that has been renamed out of recognition", () => {
    expect(cutoverDrift("const SOMETHING_ELSE = 1;")).toEqual({
      found: null,
      expected: PRE_LEDGER_BASELINE_CUTOVER,
    });
  });

  it("names a file that is on disk and sits at the floor", () => {
    expect(REAL).toContain(PRE_LEDGER_BASELINE_CUTOVER);
    expect(baselineOrdinalFloor()).toBe(ordinalOf(PRE_LEDGER_BASELINE_CUTOVER));
  });
});

describe("a shipped migration filename is frozen", () => {
  // Codex, #3192 r4036898062, P1. The round before this one recorded the
  // baseline as ORDINALS, on the reasoning that a filename roster would have
  // to be edited whenever a shipped migration is renamed — which GRANDFATHERED
  // spends forty lines explaining nobody may do. That is the argument FOR
  // freezing the names, not against it: an invariant nobody may violate is
  // exactly the one worth enforcing mechanically, because "nobody may" is a
  // comment, and this whole PR exists because a comment was doing a check's
  // job one layer up.
  //
  // The hole it left: rename a unique migration and keep its ordinal.
  // `0021_schema_conformance_events_idempotency.sql` ->
  // `0021_anything_else.sql` collides with nothing, vacates no ordinal, and
  // leaves no stale exemption. `_migrations.filename` is the ledger's only
  // key, so every deployment that recorded the old name reads the new one as
  // unapplied and replays it — and 0021 is the DROP+RECREATE of
  // schema_conformance_events, so the replay destroys retained data.

  it("preserves the shipped snapshot, including post-baseline filenames", () => {
    // The ledger keys on filename for EVERY migration, not just the ones the
    // pre-ledger baseline sweeps. Freezing only the files at or below the
    // cutover would leave 0027 renameable with the same consequence.
    for (const shipped of SHIPPED_MIGRATIONS) expect(REAL).toContain(shipped);
    expect(
      SHIPPED_MIGRATIONS.filter((f) => f > PRE_LEDGER_BASELINE_CUTOVER),
    ).toEqual(["0027_tacho_events.sql", "0028_tacho_observed_changes.sql"]);
  });

  it("covers every grandfathered name", () => {
    // An exemption for a file that never shipped would be incoherent, and a
    // grandfathered file that were NOT frozen would be renameable — the one
    // operation its own exemption note says must never happen.
    for (const g of GRANDFATHERED) expect(SHIPPED_MIGRATIONS).toContain(g);
  });

  it("catches a rename that keeps the ordinal, and names both filenames", () => {
    const renamed = REAL.filter(
      (f) => f !== "0021_schema_conformance_events_idempotency.sql",
    ).concat("0021_anything_else.sql");
    expect(shippedRenames(renamed)).toEqual([
      {
        was: "0021_schema_conformance_events_idempotency.sql",
        now: "0021_anything_else.sql",
      },
    ]);
  });

  it("catches a rename of a GRANDFATHERED file, and the exemption goes stale too", () => {
    // Renaming a grandfathered file is two separate wrongs and is reported as
    // both: the ledger will replay the file under its new name, and the
    // exemption now names something nobody can find. The GRANDFATHERED list
    // exempts an ordinal COLLISION; it has never exempted a name.
    const renamed = REAL.filter(
      (f) => f !== "0020_eval_item_results.sql",
    ).concat("0020_eval_items.sql");
    expect(shippedRenames(renamed)).toEqual([
      { was: "0020_eval_item_results.sql", now: "0020_eval_items.sql" },
    ]);
    expect(staleExemptions(renamed)).toEqual(["0020_eval_item_results.sql"]);
  });

  it("does not name a grandfathered sibling as the rename target of its own pair", () => {
    // The fabrication this guards against, asserted directly rather than as a
    // side effect of the rename tests above.
    //
    // Two files sit at ordinal 0026 — cache_write_tokens and
    // stella_operational_events, the grandfathered pair. If one goes missing,
    // the only other file at that ordinal is its SIBLING, which is itself
    // frozen and manifestly not a rename of anything. Without the frozen
    // exclusion in the candidate filter, the guard would report
    // "0026_cache_write_tokens.sql has been renamed to
    // 0026_stella_operational_events.sql" — a fabricated fact, in an error
    // message an operator reads while already in trouble, telling them to
    // restore a file that never moved. `now: null` says the true thing: it is
    // gone, and nothing here knows what became of it.
    //
    // Measured without the exclusion, this case returns
    // { was: "0026_cache_write_tokens.sql", now: "0026_stella_operational_events.sql" }.
    // The same removal fails exactly one other test, so this is the direction
    // the exclusion was otherwise unasserted in.
    const gone = REAL.filter((f) => f !== "0026_cache_write_tokens.sql");
    expect(shippedRenames(gone)).toEqual([
      { was: "0026_cache_write_tokens.sql", now: null },
    ]);

    // And the mirror at the other grandfathered ordinal, both directions, so
    // the rule is not an artefact of which half of the pair was removed.
    for (const half of [
      "0020_error_events.sql",
      "0020_eval_item_results.sql",
    ]) {
      expect(shippedRenames(REAL.filter((f) => f !== half))).toEqual([
        { was: half, now: null },
      ]);
    }
  });

  it("catches a rename that also moves the ordinal", () => {
    // No file takes the vacated ordinal, so there is no new name to point at.
    // Reported as gone rather than renamed — same consequence for the ledger,
    // and the guard does not invent a correspondence it cannot see.
    const moved = REAL.filter((f) => f !== "0025_router_outcomes.sql").concat(
      "0029_router_outcomes.sql",
    );
    expect(shippedRenames(moved)).toEqual([
      { was: "0025_router_outcomes.sql", now: null },
    ]);
  });

  it("catches a deletion", () => {
    const deleted = REAL.filter((f) => f !== "0016_memory_changes.sql");
    expect(shippedRenames(deleted)).toEqual([
      { was: "0016_memory_changes.sql", now: null },
    ]);
  });

  it("catches a rename of EVERY shipped migration, not just the reported one", () => {
    // The space, not the example — the shape that made the ordinal-floor rule
    // worth trusting. Rename each of the 27 shipped files in turn, keeping its
    // ordinal (the case that slips past every other check), and collect any
    // that escape so the failure names the escapee rather than a count.
    const escaped: string[] = [];
    for (const shipped of SHIPPED_MIGRATIONS) {
      const ordinal = ordinalOf(shipped);
      const renamed = REAL.filter((f) => f !== shipped).concat(
        `${ordinal}_renamed_in_place.sql`,
      );
      const caught = shippedRenames(renamed).some((r) => r.was === shipped);
      if (!caught) escaped.push(shipped);
    }
    expect(escaped).toEqual([]);
  });

  it("accepts a brand-new migration above the tip, with no constant edited", () => {
    // The shipped roster stays fixed. A later migration adds a file only;
    // the guard checks its ordinal without adding it to the historical roster.
    const withNew = [...REAL, nextMigration(REAL, "brand_new")].sort();
    expect(shippedRenames(withNew)).toEqual([]);
    expect(baselineBackfills(withNew)).toEqual([]);
    expect(malformed(withNew)).toEqual([]);
    expect(sortOrderConflicts(withNew)).toEqual([]);
    expect(
      offendingDuplicates(withNew).filter((g) => g.unexempt.length > 0),
    ).toEqual([]);
  });

  it("keeps the hypothetical migration above successive directory tips", () => {
    let files = [...REAL];
    for (let step = 0; step < 3; step += 1) {
      const next = nextMigration(files, "brand_new");
      expect(files).not.toContain(next);
      files = [...files, next].sort();
      expect(shippedRenames(files)).toEqual([]);
      expect(baselineBackfills(files)).toEqual([]);
      expect(sortOrderConflicts(files)).toEqual([]);
      expect(
        offendingDuplicates(files).filter((group) => group.unexempt.length > 0),
      ).toEqual([]);
    }
  });

  it("does not freeze what has not shipped: a new file may be renamed freely", () => {
    // The residual, asserted rather than left to be discovered. A migration
    // added after this roster was taken is absent from it, so renaming it is
    // invisible here — and the ledger keys on its filename just the same.
    // Closing that needs the roster to grow with every migration, which is the
    // friction the "touches no constant" property buys. Written down in the
    // guard and in the PR body; not silently absent.
    const added = [...REAL, nextMigration(REAL, "first_name")].sort();
    const thenRenamed = [...REAL, nextMigration(REAL, "second_name")].sort();
    expect(shippedRenames(added)).toEqual([]);
    expect(shippedRenames(thenRenamed)).toEqual([]);
  });
});
