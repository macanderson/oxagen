import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { sessionChangedFilesWhere } from "./file-facts-rollup";

const dialect = new PgDialect();
const SESSION = "0b0e3c1c-6a4f-4d8e-9a57-2f1c1d2b3a4e";

function rendered(observedStatusColumn: boolean) {
  const where = sessionChangedFilesWhere(SESSION, observedStatusColumn);
  if (where === undefined) throw new Error("no predicate");
  return dialect.sqlToQuery(where);
}

describe("sessionChangedFilesWhere", () => {
  it("keeps the observed half inside the session filter", () => {
    const { sql, params } = rendered(true);
    // `a and b OR c` reads as `(a and b) OR c` in Postgres, which counted
    // every observed row in the workspace for every session. The session
    // filter must bind the whole disjunction.
    expect(sql).toBe(
      '("tacho"."session_files"."session_id" = $1 and ("tacho"."session_files"."writes" + "tacho"."session_files"."edits" + "tacho"."session_files"."deletes" > 0 or "tacho"."session_files"."observed_status" in ($2, $3, $4, $5)))',
    );
    expect(params).toEqual([
      SESSION,
      "added",
      "modified",
      "deleted",
      "renamed",
    ]);
  });

  it("counts attested writes alone before the observed column exists", () => {
    const { sql, params } = rendered(false);
    expect(sql).toBe(
      '("tacho"."session_files"."session_id" = $1 and "tacho"."session_files"."writes" + "tacho"."session_files"."edits" + "tacho"."session_files"."deletes" > 0)',
    );
    expect(sql).not.toContain("observed_status");
    expect(params).toEqual([SESSION]);
  });
});
