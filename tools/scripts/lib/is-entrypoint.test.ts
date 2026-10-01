// #4664 item 1: a check script that misreads how node started it exits 0
// having checked nothing, and its CI step passes green.
// is-entrypoint.tree.test.ts starts each script that guards its body with
// `isEntrypoint`, directly and through a symlink, and requires the symlinked
// run to do what the direct run does.
//
// check-main-concurrency.mjs, check-adr-index.mjs, and check-action-pins.mjs
// compared `import.meta.url` with `file://${process.argv[1]}`, so started
// through a symlink they skipped their check and exited 0 with no output.
// `check:contracts` runs all three, so the pre-push hook and the CI step
// passed without checking. Each one prints a line naming itself only when its
// body ran, pass or fail, so silence is the failure its cases catch.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isEntrypoint } from "./is-entrypoint.mjs";

const scratch = mkdtempSync(join(tmpdir(), "is-entrypoint-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("isEntrypoint", () => {
  const module = join(scratch, "module.mjs");
  writeFileSync(module, "export {};\n");
  const url = pathToFileURL(module).href;

  it("reads true for the module node was started on", () => {
    expect(isEntrypoint(url, module)).toBe(true);
  });

  it("reads true when node was started through a symlink", () => {
    const link = join(scratch, "link.mjs");
    symlinkSync(module, link);
    // The comparison the guards used to make reads false here.
    expect(url === pathToFileURL(link).href).toBe(false);
    expect(isEntrypoint(url, link)).toBe(true);
  });

  it("reads true under a path that import.meta.url percent-encodes", () => {
    const dir = join(scratch, "a dir [1] #2");
    mkdirSync(dir);
    const spaced = join(dir, "module.mjs");
    writeFileSync(spaced, "export {};\n");
    const spacedUrl = pathToFileURL(spaced).href;
    expect(spacedUrl).toContain("%20");
    expect(isEntrypoint(spacedUrl, spaced)).toBe(true);
  });

  it("reads false for another module and for a path that does not exist", () => {
    expect(isEntrypoint(url, fileURLToPath(import.meta.url))).toBe(false);
    expect(isEntrypoint(url, join(scratch, "missing.mjs"))).toBe(false);
  });

  // A default parameter applies only to `undefined`, so these two reach the
  // missing-script branch rather than falling back to process.argv[1]
  // (#4664 item 12).
  it("reads false when node was started with no script", () => {
    expect(isEntrypoint(url, "")).toBe(false);
    expect(isEntrypoint(url, null)).toBe(false);
  });
});
