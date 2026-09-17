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
  unprefixed,
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
    expect(unprefixed(REAL)).toEqual([]);
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
    expect(unprefixed([...REAL, "no_ordinal.sql"])).toEqual(["no_ordinal.sql"]);
  });

  it("does not read a number from the middle of a name", () => {
    expect(ordinalOf("error_0020_events.sql")).toBeNull();
  });
});
