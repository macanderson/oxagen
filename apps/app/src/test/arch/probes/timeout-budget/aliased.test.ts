// The walker is reached through an alias, so no call names it directly. The
// mention at module scope is what rule 2 judges, not the shape of the call.
import { expect, it } from "vitest";
import { productionFiles, readSource } from "@/test/arch/parse";

function scan(): readonly { readonly file: string }[] {
  return productionFiles().map(readSource);
}

const run = scan;
const SOURCES = run();

it("reads what the alias gathered", () => {
  expect(SOURCES.length).toBeGreaterThan(0);
});
