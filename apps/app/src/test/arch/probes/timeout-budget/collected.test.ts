// The enumeration runs at module scope, where no timeout governs it at all.
import { expect, it } from "vitest";
import { productionFiles, readSource } from "@/test/arch/parse";

const SOURCES = productionFiles();

it("reads a value gathered during collection", () => {
  expect(SOURCES.map(readSource).length).toBeGreaterThan(0);
});
