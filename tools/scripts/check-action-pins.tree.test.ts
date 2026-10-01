/**
 * Reads every workflow and composite action under this repository's `.github`.
 * vitest.config.ts leaves `*.tree.test.ts` files out of turbo's cached tasks,
 * so `pnpm check:tree-guards` runs this one uncached in the checks job (#4664
 * item 2).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findUnpinned, workflowFiles } from "./check-action-pins.mjs";

describe("this repository", () => {
  it("pins every third-party action it runs", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const unpinned = workflowFiles(repoRoot).flatMap((file) =>
      findUnpinned(readFileSync(file, "utf8")).map(
        (hit) => `${file.slice(repoRoot.length + 1)}:${hit.line} ${hit.ref}`,
      ),
    );
    expect(unpinned).toEqual([]);
  });
});
