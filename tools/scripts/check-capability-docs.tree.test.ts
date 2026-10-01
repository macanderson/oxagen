/**
 * Reads `docs/capabilities/_index.md` and every contract source it names under
 * `packages/oxagen/src/contracts`. vitest.config.ts leaves `*.tree.test.ts`
 * files out of turbo's cached tasks, so `pnpm check:tree-guards` runs this one
 * uncached in the checks job (#4664 item 2).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findIndexMismatches,
  indexSurfaces,
} from "./check-capability-docs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("findIndexMismatches", () => {
  // The committed index against the contract sources themselves, so the
  // check holds without a regenerated manifest. Four rows had drifted
  // (#2950): resolve_approval and resolve_mcp_consent still listed the agent
  // surface ADR-175 removed, get_export_status left out mcp, and
  // list_price_entries left out cli.
  it("matches every contract's declared surfaces in the committed _index.md", () => {
    const index = readFileSync(
      join(ROOT, "docs/capabilities/_index.md"),
      "utf8",
    );
    const caps = [...indexSurfaces(index).keys()].flatMap((file) => {
      const path = join(ROOT, "packages/oxagen/src/contracts", file);
      if (!existsSync(path)) return [];
      const source = readFileSync(path, "utf8");
      const name = source.match(/name: "([a-z0-9_]+)"/)?.[1];
      const declared = source.match(/surfaces: \[([^\]]*)\]/)?.[1];
      if (name === undefined || declared === undefined) return [];
      const surfaces = [...declared.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
      return [{ file, name, surfaces }];
    });
    expect(caps.length).toBeGreaterThan(300);
    expect(findIndexMismatches(caps, index)).toEqual([]);
  });
});
