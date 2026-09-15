// baseline.json holds only entries that later worklist items remove. Each list
// names the item whose PR deletes its entries from baseline.json and from this
// file. WL-50 lands after the others and replaces the lists with an assertion
// that baseline.json is []. The arch tests fail on an entry that no longer
// occurs; this test fails on an entry no item owns, so the file only shrinks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffBaseline, parseBaseline } from "./parse";

const REMOVED_BY: Readonly<Record<string, readonly string[]>> = {
  "WL-47": [
    "e2e-files apps/app/e2e missing-entry:page-load.spec.ts",
    "e2e-files apps/app/e2e missing-entry:routes.ts",
  ],
  "WL-48": ["e2e-files apps/app/e2e missing-entry:pay.spec.ts"],
  "WL-50": [
    "e2e-files apps/app_deprecated/e2e spec-outside-apps-app",
    "e2e-files apps/app_deprecated/playwright.config.ts playwright-config-outside-apps-app",
  ],
};

describe("arch baseline", () => {
  it("holds no entry beyond those WL-47, WL-48 and WL-50 remove", () => {
    const entries = parseBaseline(
      readFileSync(new URL("./baseline.json", import.meta.url), "utf8"),
    );
    const { unexpected } = diffBaseline(
      entries,
      Object.values(REMOVED_BY).flat(),
    );
    expect(unexpected).toEqual([]);
  });
});
