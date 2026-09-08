/**
 * The store, opened from a real ESM process.
 *
 * This package is ESM, and the adapter used a bare `require("duckdb")`, which
 * is not defined there. Every real process — the CLI, a provider binary,
 * anything importing engram — got `ReferenceError: require is not defined`,
 * caught and reported as `NativeModuleUnavailableError`: a message telling the
 * operator to install an optional dependency that was already installed.
 *
 * Nothing in this suite could see it, because Vitest's module runner supplies
 * a `require`. So this test starts a separate process on a real `.mts` file.
 * The file matters: `tsx --eval` compiles to CJS, which supplies a `require`
 * of its own and would pass against the defect.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "engram-esm-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find the workspace root from ${HERE}`);
}

describe("opening the store from an ESM process", () => {
  it("does not fail on a require that ESM does not define", () => {
    const tsx = join(repoRoot(), "node_modules", ".bin", "tsx");
    if (!existsSync(tsx)) {
      throw new Error(`tsx not found at ${tsx} — run pnpm install at the root`);
    }

    // `.mts` so the file is ESM whatever the nearest package.json says, which
    // is the whole point of running it out here.
    const probe = join(scratch, "open-store.mts");
    writeFileSync(
      probe,
      [
        `import { createStore } from ${JSON.stringify(join(HERE, "index.ts"))};`,
        // Reported on stdout rather than thrown, so the assertions can tell a
        // machine without the native module apart from the defect.
        `createStore({ duckdbPath: ":memory:" }).close()`,
        `  .then(() => console.log("OPENED"))`,
        `  .catch((err) => console.log("CLOSE_FAILED " + String(err)));`,
      ].join("\n"),
      "utf8",
    );

    const run = spawnSync(tsx, [probe], { encoding: "utf8", timeout: 60_000 });
    const output = `${run.stdout}${run.stderr}`;

    expect(output).not.toContain("require is not defined");
    expect(output).toMatch(/OPENED|Cannot find module|MODULE_NOT_FOUND/);
  });
});
