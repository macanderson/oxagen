// The enumerator is reached through the module namespace.
import * as arch from "@/test/arch/parse";
import { expect, it } from "vitest";

it("walks the tree through the namespace", () => {
  expect(arch.productionFiles().map(arch.readSource).length).toBeGreaterThan(0);
});
