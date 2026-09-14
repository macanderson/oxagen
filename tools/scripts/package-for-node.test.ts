/**
 * The `app` service ships whatever APP_DIR names, and nothing else. With
 * `@oxagen/app` written into the script, the Mission Control rebuild reached
 * app.oxagen.sh the moment its integration branch merged (#2894), while the
 * parity gates still pointed at apps/app_deprecated. One source of truth for
 * "which app is the app", read by the gates and by the deploy alike — and
 * when that source is not on the tree (no rebuild in flight), apps/app.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const script = readFileSync(join(here, "package-for-node.sh"), "utf8");
const appDirModule = join(here, "lib", "app-dir.mjs");

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

describe("package-for-node.sh app", () => {
  const arm = appArm(script);

  it("resolves the app to ship from APP_DIR when the rebuild's app-dir.mjs is on the tree", () => {
    expect(arm).toMatch(/-f tools\/scripts\/lib\/app-dir\.mjs/);
    expect(arm).toMatch(/APP_DIR/);
  });

  it("falls back to apps/app when app-dir.mjs is absent", () => {
    expect(arm).toMatch(/else\s+app_dir=apps\/app\s/);
  });

  it("names no app package by hand", () => {
    expect(arm).not.toMatch(/--filter\s+@oxagen\/app\b/);
    expect(arm).not.toMatch(/--filter\s+@oxagen\/app-deprecated\b/);
    expect(arm).not.toMatch(/assemble_next\s+apps\//);
  });

  it("the directory it resolves to is a workspace package with a next build", async () => {
    const appDir = existsSync(appDirModule)
      ? ((await import(appDirModule)) as { APP_DIR: string }).APP_DIR
      : "apps/app";
    const pkg = JSON.parse(
      readFileSync(join(root, appDir, "package.json"), "utf8"),
    ) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toMatch(/^@oxagen\/app/);
    expect(pkg.scripts.build).toMatch(/next build/);
  });
});
