// A route's loading fallback never owns the page's main landmark. Next renders
// `loading.tsx` as the route segment's Suspense fallback, and while the page
// streams in, the fallback and the page are in the document together. If both
// render `<main id="main">`, the skip link has two targets and page-load's
// strict `main#main` locator fails whenever it looks during the swap. Billing's
// fallback did that on 2026-09-24, and passed or failed depending on timing.
// The fallback renders a busy region; the page owns `main`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR, productionFiles, WHOLE_TREE_TIMEOUT_MS } from "./parse";

const MAIN_LANDMARK = /<main\b[^>]*\bid=["{]\s*["']?main\b/;

describe("loading fallbacks", () => {
  it(
    "never render main#main, which the streamed page owns",
    () => {
      const fallbacks = productionFiles().filter(
        (file) => path.basename(file) === "loading.tsx",
      );
      // An empty list would pass for the wrong reason.
      expect(fallbacks.length).toBeGreaterThan(0);
      const offenders = fallbacks.filter((file) =>
        MAIN_LANDMARK.test(readFileSync(path.join(APP_DIR, file), "utf8")),
      );
      expect(offenders).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("catches a fallback that does", () => {
    expect(
      MAIN_LANDMARK.test('<main\n      id="main"\n      className="x">'),
    ).toBe(true);
    expect(MAIN_LANDMARK.test('<div aria-busy="true">')).toBe(false);
  });
});
