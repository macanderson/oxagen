/**
 * `oxagen hook` runs on every tool call a wrapped agent makes, so its start-up
 * time is on every one of them (#4879). Its entry must load the recorder's
 * hook and nothing from the CLI's command tree. Two pins hold that:
 *
 *   - `index.ts` imports nothing statically, so the dispatch to
 *     `machine/hook.ts` happens before anything else loads;
 *   - `machine/hook.ts`, bundled the way the release bundles the CLI, pulls
 *     in no file outside the recorder (`packages/tacho`) and its npm
 *     dependencies.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..", "..");
const repoRoot = resolve(cliRoot, "..", "..");
const entry = resolve(cliRoot, "src", "machine", "hook.ts");

describe("the oxagen hook entry", () => {
  it("dispatches from an entry that imports nothing statically", () => {
    const source = readFileSync(resolve(cliRoot, "src", "index.ts"), "utf8");
    // A static import would load before the dispatch can skip it.
    expect(source).not.toMatch(/^\s*import\s[^(]/m);
    expect(source).not.toMatch(/\brequire\(/);
    // The hook goes to its own module, and only the hook does.
    expect(source).toMatch(
      /if \(command === "hook"\) \{\s*import\("\.\/machine\/hook\.js"\)/,
    );
  });

  it("bundles to the recorder's hook and its npm dependencies, nothing else", async () => {
    const result = await build({
      entryPoints: [entry],
      absWorkingDir: repoRoot,
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) =>
      // esbuild keys inputs by path relative to absWorkingDir, with a
      // namespace prefix for virtual modules.
      input.replace(/^[a-z-]+:/, ""),
    );
    const ownEntry = relative(repoRoot, entry);
    expect(inputs).toContain(ownEntry);
    expect(
      inputs.some((input) => input.startsWith("packages/tacho/src/")),
      "the recorder's hook must be in the bundle",
    ).toBe(true);
    const outside = inputs.filter(
      (input) =>
        input !== ownEntry &&
        !input.startsWith("packages/tacho/") &&
        !input.includes("node_modules/"),
    );
    expect(outside).toEqual([]);
    // No other workspace package arrives by way of node_modules either.
    expect(
      inputs.filter((input) => /node_modules\/@oxagen\//.test(input)),
    ).toEqual([]);
    // A bundle is a few seconds of work on a loaded runner, well past the
    // default budget for a unit test.
  }, 60_000);
});
