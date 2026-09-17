// A whole-tree walk inside an `it` that declares no timeout.
import { expect, it } from "vitest";
import { productionFiles, readSource } from "@/test/arch/parse";

it("walks the tree on the unit budget", () => {
  expect(productionFiles().map(readSource).length).toBeGreaterThan(0);
});
