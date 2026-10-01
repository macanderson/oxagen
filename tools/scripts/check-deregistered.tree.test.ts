/**
 * Reads `DEREGISTERED.md` and checks a live contract's artifacts in this
 * repository. vitest.config.ts leaves `*.tree.test.ts` files out of turbo's
 * cached tasks, so `pnpm check:tree-guards` runs this one uncached in the
 * checks job (#4664 item 2).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { derivedMissingFor, preservedPaths } from "./check-deregistered.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the real ledger", () => {
  const markdown = readFileSync(join(repoRoot, "DEREGISTERED.md"), "utf8");

  it("carries a non-empty block, because an empty one passes vacuously", () => {
    const paths = preservedPaths(markdown);
    expect(paths).not.toBeNull();
    expect(paths!.length).toBeGreaterThan(0);
  });

  it("lists no path twice", () => {
    const paths = preservedPaths(markdown)!;
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists repo-relative paths only — an absolute path would never be checked", () => {
    for (const path of preservedPaths(markdown)!) {
      expect(path.startsWith("/")).toBe(false);
      expect(path.startsWith("./")).toBe(false);
    }
  });

  it("preserves the marketplace and the fourteen de-registered connectors", () => {
    const paths = preservedPaths(markdown)!;
    // The rebuild renamed apps/app to apps/app_deprecated, so the preserved
    // marketplace page is at that spelling now. The feature is still
    // de-registered and still on disk; only the directory moved.
    expect(paths).toContain(
      "apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/marketplace",
    );
    expect(paths).toContain(
      "packages/oxagen/src/contracts/plugin.org.install.ts",
    );
    for (const connector of [
      "google",
      "zoom",
      "slack",
      "salesforce",
      "microsoft",
      "stripe",
      "zendesk",
      "custom-webhook",
    ]) {
      expect(paths).toContain(`packages/ingestion/src/connectors/${connector}`);
    }
  });

  it("preserves the ingestion pipeline, which the Ontology page depends on", () => {
    expect(preservedPaths(markdown)!).toContain(
      "packages/ingestion/src/pipeline.ts",
    );
  });
});

describe("artifacts a preserved contract declares", () => {
  it("finds every artifact of a live contract in this repo", () => {
    const path = "packages/oxagen/src/contracts/plugin.catalog.browse.ts";
    expect(
      derivedMissingFor(
        repoRoot,
        path,
        readFileSync(join(repoRoot, path), "utf8"),
      ),
    ).toEqual([]);
  });
});
