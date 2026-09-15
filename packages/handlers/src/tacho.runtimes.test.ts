/**
 * `@oxagen/tacho` is a leaf package: the wire schema's runtime enum cannot
 * import the database's `TACHO_RUNTIMES`, so the two lists are written twice
 * and this package -- the first that depends on both -- is where they meet.
 * A value the wire admits but the CHECK constraint rejects passes every
 * validator and dies on the insert; a value the constraint admits but the
 * wire refuses can never arrive. Either drift is a silent one.
 */
import { schema } from "@oxagen/database";
import { TACHO_RUNTIMES as WIRE_RUNTIMES } from "@oxagen/tacho";
import { describe, expect, it } from "vitest";

const DB_RUNTIMES = schema.TACHO_RUNTIMES;

describe("tacho runtime enum parity", () => {
  it("the wire enum and the database CHECK list are the same list", () => {
    expect([...WIRE_RUNTIMES]).toEqual([...DB_RUNTIMES]);
  });

  it("both admit codex, so a Codex session is filed under its own runtime", () => {
    expect(WIRE_RUNTIMES).toContain("codex");
    expect(DB_RUNTIMES).toContain("codex");
  });
});
