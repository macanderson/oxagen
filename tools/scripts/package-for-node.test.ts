/**
 * The `app` service ships whatever APP_DIR names, and nothing else. With
 * `@oxagen/app` written into the script, the app rebuild reached
 * app.oxagen.sh the moment its integration branch merged (#2894), while the
 * parity gates still pointed at apps/app_deprecated. One source of truth for
 * "which app is the app", read by the gates and by the deploy alike — and
 * when that source is not on the tree (no rebuild in flight), apps/app.
 *
 * `resolve_app_dir` is executed here, not pattern-matched: once in a scratch
 * tree carrying an app-dir.mjs and once in a tree without one.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const script = readFileSync(join(here, "package-for-node.sh"), "utf8");
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

/** The `app)` arm of the service switch, comments removed. */
function appArm(source: string): string {
  const start = source.indexOf("\n  app)\n");
  const end = source.indexOf("\n  api)\n", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("resolve_app_dir", () => {
  it("returns APP_DIR when the rebuild's app-dir.mjs is on the tree", () => {
    const tree = mkdtempSync(join(tmpdir(), "app-dir-"));
    mkdirSync(join(tree, "tools", "scripts", "lib"), { recursive: true });
    writeFileSync(
      join(tree, "tools", "scripts", "lib", "app-dir.mjs"),
      'export const APP_DIR = "apps/app_deprecated";\n',
    );
    expect(resolveIn(tree)).toBe("apps/app_deprecated");
  });

  it("returns apps/app when app-dir.mjs is absent", () => {
    const tree = mkdtempSync(join(tmpdir(), "app-dir-"));
    expect(resolveIn(tree)).toBe("apps/app");
  });

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

describe("package-for-node.sh app", () => {
  const arm = appArm(script);

  it("takes its app from resolve_app_dir", () => {
    expect(arm).toMatch(/\. tools\/scripts\/lib\/app-dir\.sh/);
    expect(arm).toMatch(/app_dir=\$\(resolve_app_dir\)/);
  });

  it("names no app package by hand", () => {
    expect(arm).not.toMatch(/--filter\s+@oxagen\/app\b/);
    expect(arm).not.toMatch(/--filter\s+@oxagen\/app-deprecated\b/);
    expect(arm).not.toMatch(/assemble_next\s+apps\//);
  });
});
