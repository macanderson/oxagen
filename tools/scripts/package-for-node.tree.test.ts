// This test runs `resolve_app_dir` at the repository root and reads the
// package.json of the app it names from the live tree. vitest.config.ts
// leaves `*.tree.test.ts` files out of turbo's cached tasks, so
// `pnpm check:tree-guards` runs them uncached in the checks job (#4664 item 2).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const resolver = join(here, "lib", "app-dir.sh");

/** Run `resolve_app_dir` from the root of `tree`, as package-for-node.sh does. */
function resolveIn(tree: string): string {
  return execFileSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      `cd "$1" && . "$2" && resolve_app_dir`,
      "_",
      tree,
      resolver,
    ],
    { encoding: "utf8" },
  );
}

describe("resolve_app_dir", () => {
  it("names, on this tree, a workspace package with a next build", () => {
    const appDir = resolveIn(root);
    expect(existsSync(join(root, appDir, "package.json"))).toBe(true);
    const pkg = JSON.parse(
      readFileSync(join(root, appDir, "package.json"), "utf8"),
    ) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toMatch(/^@oxagen\/app/);
    expect(pkg.scripts.build).toMatch(/next build/);
  });
});
