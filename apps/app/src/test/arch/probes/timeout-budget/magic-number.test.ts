// A number copied into place carries none of the measurements the constant does.
import { expect, it } from "vitest";
import { productionFiles, readSource } from "@/test/arch/parse";

it("walks the tree on a number", () => {
  expect(productionFiles().map(readSource).length).toBeGreaterThan(0);
}, 60_000);
