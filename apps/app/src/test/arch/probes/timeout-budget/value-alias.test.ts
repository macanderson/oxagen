// The enumerator is copied into a local binding, so the callee names a variable
// rather than the import. It is still the same declaration.
import { expect, it } from "vitest";
import { productionFiles } from "@/test/arch/parse";

const files = productionFiles;

it("walks the tree under a value alias", () => {
  expect(files().length).toBeGreaterThan(0);
});
