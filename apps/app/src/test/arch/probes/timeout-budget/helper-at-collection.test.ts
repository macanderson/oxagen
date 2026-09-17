// The walk is one call away from module scope: a named helper, invoked during
// collection, with a test that only reads the result.
import { expect, it } from "vitest";
import {
  productionFiles,
  readSource,
  type SourceText,
} from "@/test/arch/parse";

function sources(): readonly SourceText[] {
  return productionFiles().map(readSource);
}

const SOURCES = sources();

it("reads what the helper gathered at collection", () => {
  expect(SOURCES.length).toBeGreaterThan(0);
});
