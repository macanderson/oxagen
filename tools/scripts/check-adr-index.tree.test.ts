/**
 * Reads the ADR files in `docs/adr` and the index in `docs/adr/README.md`.
 * vitest.config.ts leaves `*.tree.test.ts` files out of turbo's cached tasks,
 * so `pnpm check:tree-guards` runs this one uncached in the checks job (#4664
 * item 2).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deadIndexLinks,
  duplicateNumbers,
  missingFromIndex,
} from "./check-adr-index.mjs";

describe("the repository's ADR index", () => {
  it("links every ADR in docs/adr and no missing file", () => {
    const adrDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "docs",
      "adr",
    );
    const files = readdirSync(adrDir);
    const readme = readFileSync(join(adrDir, "README.md"), "utf8");
    expect(missingFromIndex(files, readme)).toEqual([]);
    expect(deadIndexLinks(files, readme)).toEqual([]);
    expect(duplicateNumbers(files)).toEqual([]);
  });
});
