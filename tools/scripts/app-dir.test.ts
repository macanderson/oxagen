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
