// baseline.json held only entries that later worklist items removed: the three
// e2e files WL-47 and WL-48 were to add, and the two apps/app_deprecated entries
// WL-50 was to delete. WL-50 has landed all five, so the file is now [] and this
// test asserts exactly that — the arch tests own every rule from here, with
// nothing grandfathered. A new entry cannot be added back without deleting this
// assertion, which is the point: the file only ever shrank, and it has reached
// zero.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBaseline } from "./parse";

describe("arch baseline", () => {
  it("is empty: no arch finding is grandfathered", () => {
    const entries = parseBaseline(
      readFileSync(new URL("./baseline.json", import.meta.url), "utf8"),
    );
    expect(entries).toEqual([]);
  });
});
