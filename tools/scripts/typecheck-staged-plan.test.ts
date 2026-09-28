/**
 * #3403 (absorbed #3429 and #4054): on a checkout with no `apps/app/.next`,
 * the pre-commit staged typecheck refused every commit that staged an app
 * route, with TS2304 "Cannot find name 'PageProps'". These hold the decisions
 * that fix it: generate route types only for a package whose own typecheck
 * does, only when they are missing, and put them in the staged program.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ROUTE_TYPES,
  generatedDeclarations,
  needsTypegen,
  runsNextTypegen,
  stagedConfig,
} from "./lib/typecheck-staged-plan.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readPkg = (dir: string) =>
  JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));

const APP = "/repo/apps/app";
const APP_PKG = { scripts: { typecheck: "next typegen && tsc --noEmit" } };
const PLAIN_PKG = { scripts: { typecheck: "tsc --noEmit" } };

const fs = (paths: string[], dirs: Record<string, string[]> = {}) => ({
  exists: (p: string) => paths.includes(p) || p in dirs,
  readdir: (p: string) => dirs[p] ?? [],
});

describe("which packages get route types", () => {
  it("follows the package's own typecheck script", () => {
    expect(runsNextTypegen(APP_PKG)).toBe(true);
    expect(runsNextTypegen(PLAIN_PKG)).toBe(false);
    expect(runsNextTypegen({})).toBe(false);
  });

  it("matches the real tree: apps/app generates, the other Next apps do not", () => {
    // If apps/app's typecheck stops running typegen, or another app starts,
    // this says so, because the hook's behaviour changes with it.
    expect(runsNextTypegen(readPkg("apps/app"))).toBe(true);
    expect(runsNextTypegen(readPkg("apps/app_deprecated"))).toBe(false);
    expect(runsNextTypegen(readPkg("apps/docs"))).toBe(false);
    expect(runsNextTypegen(readPkg("tools/scripts"))).toBe(false);
  });
});

describe("needsTypegen", () => {
  it("asks for typegen on a fresh checkout with no .next", () => {
    // The witness: this is the state every new worktree starts in.
    expect(needsTypegen(APP, APP_PKG, fs([]).exists)).toBe(true);
  });

  it("does not regenerate route types that are already present", () => {
    expect(
      needsTypegen(APP, APP_PKG, fs([`${APP}/${ROUTE_TYPES}`]).exists),
    ).toBe(false);
  });

  it("never generates for a package whose typecheck does not", () => {
    // A staged file outside apps/app lands in a group like this one, so no
    // Next invocation happens on that commit.
    expect(
      needsTypegen("/repo/packages/oxagen", PLAIN_PKG, fs([]).exists),
    ).toBe(false);
    expect(needsTypegen("/repo/apps/docs", PLAIN_PKG, fs([]).exists)).toBe(
      false,
    );
  });
});

describe("generatedDeclarations", () => {
  it("adds next-env.d.ts and the .d.ts files directly under .next/types", () => {
    const io = fs([`${APP}/next-env.d.ts`], {
      [`${APP}/.next/types`]: [
        "validator.ts",
        "routes.d.ts",
        "cache-life.d.ts",
        "app",
      ],
    });
    expect(generatedDeclarations(APP, APP_PKG, io)).toEqual([
      "next-env.d.ts",
      ".next/types/cache-life.d.ts",
      ".next/types/routes.d.ts",
    ]);
  });

  it("leaves out validator.ts, which would typecheck every route", () => {
    const io = fs([], {
      [`${APP}/.next/types`]: ["validator.ts", "routes.d.ts"],
    });
    expect(generatedDeclarations(APP, APP_PKG, io)).not.toContain(
      ".next/types/validator.ts",
    );
  });

  it("adds nothing for a package that does not generate route types", () => {
    const io = fs(["/repo/apps/docs/next-env.d.ts"], {
      "/repo/apps/docs/.next/types": ["routes.d.ts"],
    });
    expect(generatedDeclarations("/repo/apps/docs", PLAIN_PKG, io)).toEqual([]);
  });

  it("adds nothing when typegen has not produced anything", () => {
    expect(generatedDeclarations(APP, APP_PKG, fs([]))).toEqual([]);
  });
});

describe("stagedConfig", () => {
  it("puts the generated declarations in files, where the package's exclude of .next cannot drop them", () => {
    const config = stagedConfig(
      ["src/app/[org]/audit/page.tsx"],
      ["next-env.d.ts", ".next/types/routes.d.ts"],
    );
    expect(config.files).toEqual([
      "src/app/[org]/audit/page.tsx",
      "next-env.d.ts",
      ".next/types/routes.d.ts",
    ]);
    expect(config.extends).toBe("./tsconfig.json");
    expect(config.include).toEqual(["**/*.d.ts"]);
  });

  it("still checks only the staged files, so a real error in a route file is reported", () => {
    // The staged route file stays in `files`: tsc checks it in full, and
    // nothing here widens the program to the rest of the app.
    const config = stagedConfig(
      ["src/app/page.tsx"],
      [".next/types/routes.d.ts"],
    );
    expect(config.files[0]).toBe("src/app/page.tsx");
    expect(config.files).not.toContain(".next/types/validator.ts");
    expect(config.compilerOptions).toEqual({
      noEmit: true,
      declaration: false,
      declarationMap: false,
    });
  });

  it("does not list a staged declaration twice", () => {
    expect(stagedConfig(["next-env.d.ts"], ["next-env.d.ts"]).files).toEqual([
      "next-env.d.ts",
    ]);
  });

  it("is the config the hook writes when nothing is generated", () => {
    expect(stagedConfig(["src/a.ts"]).files).toEqual(["src/a.ts"]);
  });
});

describe("typecheck-staged.mjs uses the plan", () => {
  const source = readFileSync(
    join(repoRoot, "tools/scripts/typecheck-staged.mjs"),
    "utf8",
  );

  it("runs typegen only behind needsTypegen, and writes the planned config", () => {
    expect(source).toContain('from "./lib/typecheck-staged-plan.mjs"');
    expect(source).toMatch(
      /if \(needsTypegen\(pkgDir, pkgJson, existsSync\)\)/,
    );
    expect(source).toContain('["exec", "next", "typegen"]');
    expect(source).toMatch(/stagedConfig\(/);
  });

  it("describes how route files are handled in its header comment", () => {
    const header = source.slice(0, source.search(/^import /m));
    expect(header).toContain("PageProps");
    expect(header).toContain("next typegen");
  });
});
