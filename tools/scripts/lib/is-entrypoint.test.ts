/**
 * The shared entrypoint test, and the guards that use it, started through a
 * symlink.
 *
 * check-main-concurrency.mjs, check-adr-index.mjs, and check-action-pins.mjs
 * each compared `import.meta.url` with `file://${process.argv[1]}`. Node
 * resolves symlinks in the first and not in the second, so a guard started
 * through a symlinked path skipped its check and exited 0 with no output.
 * `check:contracts` runs all three, so the pre-push hook and the CI step
 * passed without checking. run-checks.mjs and check-checks-job-continues.mjs
 * carried their own real-path copies, and now share this one. Each guard
 * below prints a line naming itself only when its body ran, pass or fail, so
 * silence is the failure this catches.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntrypoint } from "./is-entrypoint.mjs";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("isEntrypoint", () => {
  const self = fileURLToPath(import.meta.url);
  const url = import.meta.url;

  it("reads true for the module's own path and its real path", () => {
    expect(isEntrypoint(url, self)).toBe(true);
    expect(isEntrypoint(url, realpathSync(self))).toBe(true);
  });

  it("reads true through a symlink to the module", () => {
    const dir = mkdtempSync(join(tmpdir(), "is-entrypoint-"));
    try {
      const link = join(dir, "linked.test.ts");
      symlinkSync(self, link);
      // The comparison the guards used to make reads false here.
      expect(url === pathToFileURL(link).href).toBe(false);
      expect(isEntrypoint(url, link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads false for no script, another script, and a missing file", () => {
    // "" and not undefined: undefined takes the default, process.argv[1],
    // and never reaches the no-script branch (#4664 item 12).
    expect(isEntrypoint(url, "")).toBe(false);
    expect(isEntrypoint(url, join(scriptsDir, "run-checks.mjs"))).toBe(false);
    expect(isEntrypoint(url, "/no/such/file.mjs")).toBe(false);
  });
});

/** Start `script` through a symlink in a temporary directory. */
function runThroughSymlink(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "guard-link-"));
  try {
    const link = join(dir, script);
    symlinkSync(join(scriptsDir, script), link);
    return spawnSync(process.execPath, [link], {
      cwd: join(scriptsDir, "..", ".."),
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("guards started through a symlink run their check", () => {
  it.each([
    "check-main-concurrency.mjs",
    "check-adr-index.mjs",
    "check-action-pins.mjs",
    "check-checks-job-continues.mjs",
  ])("%s", (script) => {
    const result = runThroughSymlink(script);
    const name = script.replace(/\.mjs$/, "");
    // Pass or fail, the guard names itself when its body runs. A skipped
    // guard prints nothing and exits 0.
    expect(`${result.stdout}${result.stderr}`).toContain(`${name}:`);
  });

  it("run-checks.mjs", () => {
    // With no check named, a runner that started exits 2. A skipped one
    // exits 0, and the CI step that runs it would pass having run nothing.
    const result = runThroughSymlink("run-checks.mjs");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("name at least one pnpm script");
  });
});
