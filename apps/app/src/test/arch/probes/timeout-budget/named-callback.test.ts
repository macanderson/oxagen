// The registrar is handed a named function rather than an inline one: the walk
// is in the callback, but the callback is an identifier.
import { expect, it } from "vitest";
import { productionFiles, readSource } from "@/test/arch/parse";

function scan(): void {
  expect(productionFiles().map(readSource).length).toBeGreaterThan(0);
}

it("scans", scan);
