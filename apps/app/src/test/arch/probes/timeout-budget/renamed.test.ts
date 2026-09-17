// The enumerator arrives under another name. The walk is the same walk.
import { productionFiles as files, readSource } from "@/test/arch/parse";
import { expect, it } from "vitest";

it("walks the tree under a renamed import", () => {
  expect(files().map(readSource).length).toBeGreaterThan(0);
});
