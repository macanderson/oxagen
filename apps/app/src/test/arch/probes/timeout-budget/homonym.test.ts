// A local function spelled like the enumerator. Same name, different
// declaration: matching the spelling calls this a whole-tree walk, resolving
// the binding does not. This is the converse of the renamed import, and the
// row that shows the predicate got more accurate rather than merely louder.
import { expect, it } from "vitest";

function productionFiles(): string[] {
  return ["src/data/ports.ts"];
}

it("reads one named file", () => {
  expect(productionFiles().length).toBe(1);
});
