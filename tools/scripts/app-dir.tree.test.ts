// This test reads the live tree under APP_DIR, so it is a `*.tree.test.ts`
// file. `pnpm check:tree-guards` runs it uncached in the checks job, outside
// turbo's cached `test:unit` task (#4664 item 2).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR } from "./lib/app-dir.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

// The parity gates exit 2 ("broken repo") when APP_DIR lacks these, and
// check_manifest silently reports every e2e layer missing when e2e/ is gone.
describe("APP_DIR", () => {
  it.each([
    "src",
    "e2e",
    "capability-ui-map.json",
    "capability-ui-parity-baseline.json",
    "mobile-parity.json",
  ])("contains %s", (entry) => {
    expect(existsSync(join(ROOT, APP_DIR, entry))).toBe(true);
  });
});
