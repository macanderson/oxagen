// A named subtree is not the whole tree and keeps the unit budget.
import { expect, it } from "vitest";
import { listFiles, readSource } from "@/test/arch/parse";

it("lists one feature directory", () => {
  expect(listFiles("src/features").map(readSource).length).toBeGreaterThan(0);
});
