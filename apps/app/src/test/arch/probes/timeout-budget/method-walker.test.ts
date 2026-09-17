// The walk sits in a METHOD body, which is deferred exactly as a function
// expression's body is, so the budget belongs on the registrar that runs it.
import { expect, it } from "vitest";
import { productionFiles } from "@/test/arch/parse";

const scanner = {
  scan(): string[] {
    return productionFiles();
  },
};

it("walks through a method", () => {
  expect(scanner.scan().length).toBeGreaterThan(0);
});
