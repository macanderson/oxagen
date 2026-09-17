// The walk is one call away: the helper carries it into the test's budget.
import { expect, it } from "vitest";
import { productionFiles, readSource } from "@/test/arch/parse";

function sources(): readonly { readonly file: string }[] {
  return productionFiles().map(readSource);
}

it("walks the tree through a helper", () => {
  expect(sources().length).toBeGreaterThan(0);
});
