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
import { describe, expect, it } from "vitest";
import {
  GRANDFATHERED,
  MIGRATIONS_DIR,
  duplicateOrdinals,
  offendingDuplicates,
  ordinalOf,
  sqlFilesIn,
  staleExemptions,
  malformed,
  overlooked,
  sortOrderConflicts,
} from "./check-ch-migration-ordinals.mjs";

/** What is actually on disk right now. */
const REAL: string[] = sqlFilesIn(MIGRATIONS_DIR);

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
      [...REAL, "0028_brand_new.sql"].sort(),
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
    ).concat("0029_eval_item_results.sql");
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
