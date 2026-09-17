import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR } from "./lib/app-dir.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

// The parity gates exit 2 ("broken repo") when APP_DIR lacks these, and
// check_manifest silently reports every e2e layer missing when e2e/ is gone.
//
// capability-ui-parity-baseline.json is deliberately NOT in this list. It is
// the grandfathered-gap ratchet, and check_ui_parity.mjs treats its absence as
// an empty baseline — "Missing file = empty baseline (every gap blocks), which
// is the strictest, safest default". The rebuilt app carries no baseline
// because it grandfathers nothing: --strict passes with 0 grandfathered. So a
// missing baseline is the intended post-cutover state and the strictest one,
// not a gap. It was listed here while APP_DIR pointed at apps/app_deprecated,
// which does carry one; the WL-50 flip to apps/app left the entry behind.
describe("APP_DIR", () => {
  it.each(["src", "e2e", "capability-ui-map.json", "mobile-parity.json"])(
    "contains %s",
    (entry) => {
      expect(existsSync(join(ROOT, APP_DIR, entry))).toBe(true);
    },
  );
});
