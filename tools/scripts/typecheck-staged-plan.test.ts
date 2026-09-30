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
  routeLists,
  routeOf,
  runsNextTypegen,
  stagedConfig,
  typegenCommand,
} from "./lib/typecheck-staged-plan.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readPkg = (dir: string) =>
  JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));

const APP = "/repo/apps/app";
const APP_PKG = { scripts: { typecheck: "next typegen && tsc --noEmit" } };
const PLAIN_PKG = { scripts: { typecheck: "tsc --noEmit" } };

const fs = (paths: string[]) => ({
  exists: (p: string) => paths.includes(p),
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
    expect(
      needsTypegen("/repo/apps/docs", PLAIN_PKG, fs([]).exists, {
        staged: ["src/app/new/page.tsx"],
        read: () => "",
      }),
    ).toBe(false);
  });
});

// A trimmed copy of what `next typegen` writes for apps/app.
const ROUTES_DTS = [
  "// This file is generated automatically by Next.js",
  'type AppRoutes = "/" | "/[org]" | "/[org]/audit" | "/[org]/[ws]/spend/[[...tab]]" | "/login"',
  'type AppRouteHandlerRoutes = "/[org]/audit/export" | "/api/auth/[...all]"',
  "type PageRoutes = never",
  'type LayoutRoutes = "/" | "/[org]" | "/[org]/[ws]"',
  "type RedirectRoutes = never",
  "",
  "interface ParamMap {",
  '  "/[org]/audit": { "org": string; }',
  "}",
].join("\n");

describe("routeOf", () => {
  it("reads the route and the alias that lists it from a route file's path", () => {
    expect(routeOf("src/app/[org]/audit/page.tsx")).toEqual({
      route: "/[org]/audit",
      alias: "AppRoutes",
    });
    expect(routeOf("src/app/[org]/layout.tsx")).toEqual({
      route: "/[org]",
      alias: "LayoutRoutes",
    });
    expect(routeOf("src/app/[org]/audit/export/route.ts")).toEqual({
      route: "/[org]/audit/export",
      alias: "AppRouteHandlerRoutes",
    });
    expect(routeOf("src/app/page.tsx")).toEqual({
      route: "/",
      alias: "AppRoutes",
    });
    expect(routeOf("app/[org]/page.tsx")).toEqual({
      route: "/[org]",
      alias: "AppRoutes",
    });
  });

  it("drops route groups, which are not part of the URL", () => {
    expect(routeOf("src/app/(auth)/login/page.tsx")).toEqual({
      route: "/login",
      alias: "AppRoutes",
    });
  });

  it("marks a parallel-route slot or a default file, which change the slot map", () => {
    expect(routeOf("src/app/[org]/@modal/page.tsx")).toBe("slot");
    expect(routeOf("src/app/[org]/default.tsx")).toBe("slot");
  });

  it("ignores files that declare no route", () => {
    expect(routeOf("src/app/[org]/audit/audit-table.tsx")).toBeNull();
    expect(routeOf("src/app/[org]/audit/page.test.tsx")).toBeNull();
    expect(routeOf("src/components/page.tsx")).toBeNull();
    expect(routeOf("src/app/[org]/loading.tsx")).toBeNull();
  });
});

describe("routeLists", () => {
  it("reads the quoted routes of each alias", () => {
    const lists = routeLists(ROUTES_DTS);
    expect(lists.get("AppRoutes")).toEqual(
      new Set([
        "/",
        "/[org]",
        "/[org]/audit",
        "/[org]/[ws]/spend/[[...tab]]",
        "/login",
      ]),
    );
    expect(lists.get("LayoutRoutes")).toEqual(
      new Set(["/", "/[org]", "/[org]/[ws]"]),
    );
    expect(lists.get("PageRoutes")).toEqual(new Set());
  });
});

describe("needsTypegen with route types already on disk (#4664 item 3)", () => {
  const onDisk = fs([`${APP}/${ROUTE_TYPES}`]).exists;
  const read = () => ROUTES_DTS;

  it("regenerates when a staged page declares a route the file does not list", () => {
    // The witness: before this, a commit adding a page typed
    // PageProps<"/[org]/z2-probe"> failed with TS2344 against the old list.
    expect(
      needsTypegen(APP, APP_PKG, onDisk, {
        staged: ["src/app/[org]/z2-probe/page.tsx"],
        read,
      }),
    ).toBe(true);
  });

  it("regenerates for a new layout on a route that has only a page", () => {
    // "/[org]/audit" is in AppRoutes but not in LayoutRoutes, so
    // LayoutProps<"/[org]/audit"> needs a fresh list.
    expect(
      needsTypegen(APP, APP_PKG, onDisk, {
        staged: ["src/app/[org]/audit/layout.tsx"],
        read,
      }),
    ).toBe(true);
  });

  it("regenerates for a new route handler and for a slot", () => {
    expect(
      needsTypegen(APP, APP_PKG, onDisk, {
        staged: ["src/app/api/new/route.ts"],
        read,
      }),
    ).toBe(true);
    expect(
      needsTypegen(APP, APP_PKG, onDisk, {
        staged: ["src/app/[org]/@modal/page.tsx"],
        read,
      }),
    ).toBe(true);
  });

  it("does not regenerate for routes the file already lists", () => {
    expect(
      needsTypegen(APP, APP_PKG, onDisk, {
        staged: [
          "src/app/[org]/audit/page.tsx",
          "src/app/(auth)/login/page.tsx",
          "src/app/[org]/layout.tsx",
          "src/app/[org]/audit/export/route.ts",
          "src/app/[org]/audit/audit-table.tsx",
        ],
        read,
      }),
    ).toBe(false);
  });

  it("does not regenerate when no staged file is a route entry", () => {
    expect(
      needsTypegen(APP, APP_PKG, onDisk, {
        staged: ["src/features/audit/audit.tsx"],
        read,
      }),
    ).toBe(false);
  });

  it("regenerates when routes.d.ts cannot be read", () => {
    expect(
      needsTypegen(APP, APP_PKG, onDisk, {
        staged: ["src/app/[org]/audit/page.tsx"],
        read: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBe(true);
  });
});

describe("typegenCommand (#4664 item 6)", () => {
  const ROOT = "/repo";
  const realpath = (p: string) => `/real${p}`;

  it("runs the package's own next binary by its real path, not through pnpm", () => {
    const io = {
      exists: fs([`${APP}/node_modules/.bin/next`]).exists,
      realpath,
    };
    expect(typegenCommand(APP, ROOT, io)).toEqual({
      command: `/real${APP}/node_modules/.bin/next`,
      args: ["typegen"],
    });
  });

  it("falls back to the root's next binary", () => {
    const io = { exists: fs([`${ROOT}/node_modules/.bin/next`]).exists, realpath };
    expect(typegenCommand(APP, ROOT, io)?.command).toBe(
      `/real${ROOT}/node_modules/.bin/next`,
    );
  });

  it("is null when no next binary is installed", () => {
    expect(typegenCommand(APP, ROOT, { exists: () => false, realpath })).toBeNull();
  });
});

describe("generatedDeclarations", () => {
  // Everything `next typegen` writes for apps/app, with typedRoutes on.
  const typegenOutput = [
    `${APP}/next-env.d.ts`,
    `${APP}/.next/types/routes.d.ts`,
    `${APP}/.next/types/link.d.ts`,
    `${APP}/.next/types/cache-life.d.ts`,
    `${APP}/.next/types/validator.ts`,
  ];

  it("adds next-env.d.ts and routes.d.ts, what the package's program loads", () => {
    expect(generatedDeclarations(APP, APP_PKG, fs(typegenOutput))).toEqual([
      "next-env.d.ts",
      ROUTE_TYPES,
    ]);
  });

  it("leaves out every other generated file, so the check is not stricter than CI's", () => {
    // validator.ts imports every route and link.d.ts narrows every href. The
    // package's tsconfig excludes .next, so its own typecheck loads neither.
    const added = generatedDeclarations(APP, APP_PKG, fs(typegenOutput));
    expect(added).not.toContain(".next/types/validator.ts");
    expect(added).not.toContain(".next/types/link.d.ts");
    expect(added).not.toContain(".next/types/cache-life.d.ts");
  });

  it("adds routes.d.ts alone when next-env.d.ts was not written", () => {
    const io = fs([`${APP}/${ROUTE_TYPES}`]);
    expect(generatedDeclarations(APP, APP_PKG, io)).toEqual([ROUTE_TYPES]);
  });

  it("adds nothing for a package that does not generate route types", () => {
    const io = fs([
      "/repo/apps/docs/next-env.d.ts",
      `/repo/apps/docs/${ROUTE_TYPES}`,
    ]);
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
    // needsTypegen gets the staged paths, so a new route regenerates.
    expect(source).toMatch(
      /needsTypegen\(pkgDir, pkgJson, existsSync, \{\s*staged,/,
    );
    expect(source).toMatch(/stagedConfig\(/);
  });

  it("starts typegen through typegenCommand, never through pnpm", () => {
    expect(source).toMatch(/typegenCommand\(pkgDir, repoRoot,/);
    expect(source).toMatch(/spawnSync\(typegen\.command, typegen\.args,/);
    expect(source).not.toMatch(/spawnSync\("pnpm"/);
  });

  it("describes how route files are handled in its header comment", () => {
    const header = source.slice(0, source.search(/^import /m));
    expect(header).toContain("PageProps");
    expect(header).toContain("next typegen");
  });
});
