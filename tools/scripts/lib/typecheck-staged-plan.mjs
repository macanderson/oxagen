/**
 * The decisions `tools/scripts/typecheck-staged.mjs` makes, kept pure so a
 * test can hold them (#3403).
 *
 * `apps/app`'s route files type their props with `PageProps<"/[org]/audit">`,
 * a global that exists only in `.next/types/routes.d.ts`. `next typegen`
 * writes that file (and `next-env.d.ts`, which imports it), and `apps/app`'s
 * own `typecheck` script runs `next typegen && tsc --noEmit`, which is why CI
 * is green. Both files are gitignored. So on a fresh clone or a new worktree
 * the staged typecheck failed every commit that staged a route file with
 * TS2304 "Cannot find name 'PageProps'", and the only way past it was
 * `--no-verify`, which skips format and lint too.
 *
 * The hook now mirrors each package's own typecheck: a package whose
 * `typecheck` script runs `next typegen` gets its route types generated when
 * they are missing, or when a staged route file declares a route they do not
 * list yet, and the generated declarations are put in the staged program. No
 * other package is touched, and nothing is generated when no staged file
 * belongs to such a package.
 */
import { join } from "node:path";

/** Where `next typegen` writes the file that declares `PageProps`. */
export const ROUTE_TYPES = ".next/types/routes.d.ts";

/**
 * Whether a package's own typecheck generates Next's route types first. The
 * hook generates them exactly when the package's real typecheck does.
 *
 * @param {{ scripts?: Record<string, string> }} pkgJson the package.json
 */
export function runsNextTypegen(pkgJson) {
  return /\bnext typegen\b/.test(pkgJson?.scripts?.typecheck ?? "");
}

/** An App Router file that puts a route in `routes.d.ts`. */
const ROUTE_ENTRY = /^(?:src\/)?app\/(?:(.*)\/)?(page|layout|route|default)\.(?:tsx|ts|jsx|js)$/;

/**
 * The route an App Router file declares, and the `routes.d.ts` type alias
 * that lists it. Route groups such as `(auth)` are not part of the URL, so
 * they are dropped. Null for a file that is not a route entry, and for one
 * that sits in a parallel-route slot (`@modal`) or is a slot's `default`:
 * those change the slot map, not a route list, so the caller regenerates.
 *
 * @param {string} file package-relative path, with forward slashes
 * @returns {{ route: string, alias: string } | null | "slot"}
 */
export function routeOf(file) {
  const match = ROUTE_ENTRY.exec(file);
  if (!match) return null;
  const [, dir = "", kind] = match;
  const segments = dir.split("/").filter(Boolean);
  if (kind === "default" || segments.some((s) => s.startsWith("@"))) {
    return "slot";
  }
  const kept = segments.filter((s) => !/^\([^)]*\)$/.test(s));
  const route = `/${kept.join("/")}`;
  const alias = {
    page: "AppRoutes",
    layout: "LayoutRoutes",
    route: "AppRouteHandlerRoutes",
  }[kind];
  return { route, alias };
}

/**
 * The quoted routes each `type X = "..." | "..."` alias in `routes.d.ts`
 * lists.
 *
 * @param {string} text the contents of `routes.d.ts`
 * @returns {Map<string, Set<string>>}
 */
export function routeLists(text) {
  const lists = new Map();
  for (const [, name, body] of text.matchAll(/^type (\w+) = (.*)$/gm)) {
    lists.set(name, new Set([...body.matchAll(/"([^"]*)"/g)].map((m) => m[1])));
  }
  return lists;
}

/**
 * Whether the hook has to run `next typegen` for this package before tsc.
 *
 * False when the package does not use generated route types. True when
 * `routes.d.ts` is missing, which is every fresh clone and new worktree.
 * When the file exists, true only when a staged App Router file declares a
 * route that the file does not list yet: a new page, layout, or route
 * handler, or a renamed one. Without that, a commit that adds
 * `src/app/[org]/new/page.tsx` typed `PageProps<"/[org]/new">` failed with
 * TS2344 while CI, which runs typegen first, accepted it (#4664 item 3).
 * Everything else reuses the types on disk: the hook runs on every commit,
 * and typegen loads the whole Next config.
 *
 * @param {string} pkgDir absolute package directory
 * @param {{ scripts?: Record<string, string> }} pkgJson
 * @param {(p: string) => boolean} exists
 * @param {{ staged?: string[], read?: (p: string) => string }} [change]
 *   package-relative staged paths, and a reader for `routes.d.ts`
 */
export function needsTypegen(pkgDir, pkgJson, exists, change = {}) {
  if (!runsNextTypegen(pkgJson)) return false;
  const routeTypes = join(pkgDir, ROUTE_TYPES);
  if (!exists(routeTypes)) return true;
  const entries = (change.staged ?? [])
    .map((f) => routeOf(f.split("\\").join("/")))
    .filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.includes("slot") || !change.read) return true;
  let lists;
  try {
    lists = routeLists(change.read(routeTypes));
  } catch {
    return true;
  }
  return entries.some(({ route, alias }) => !lists.get(alias)?.has(route));
}

/**
 * The command that runs `next typegen` for a package: the `next` binary the
 * package installs, by its real path, so pnpm is not involved. The staged
 * typecheck starts `tsc` the same way, because a pnpm `.bin` shim reached
 * through a symlinked `node_modules` resolves its target against the wrong
 * directory, and `pnpm exec` can start an install or refuse to run in a
 * sparse worktree (#4664 item 6). Null when no `next` binary is installed.
 *
 * @param {string} pkgDir absolute package directory
 * @param {string} repoRoot absolute repository root
 * @param {{ exists: (p: string) => boolean, realpath: (p: string) => string }} io
 * @returns {{ command: string, args: string[] } | null}
 */
export function typegenCommand(pkgDir, repoRoot, { exists, realpath }) {
  for (const dir of [pkgDir, repoRoot]) {
    const bin = join(dir, "node_modules", ".bin", "next");
    if (exists(bin)) return { command: realpath(bin), args: ["typegen"] };
  }
  return null;
}

/**
 * The generated declaration files to add to the staged program, relative to
 * the package. `apps/app/tsconfig.json` excludes `.next`, and the temp
 * config's `include` inherits that `exclude`, so its `**\/*.d.ts` pattern never
 * reaches `.next/types`. Files named in `files` are not subject to `exclude`,
 * so they go there.
 *
 * Only `next-env.d.ts` and `routes.d.ts` are taken, because the package's
 * real program loads no more than that: the same `exclude` hides `.next` from
 * its `include`, and `next-env.d.ts` imports `routes.d.ts`. The staged program
 * must not be stricter than CI's, or it refuses a commit CI would accept and
 * the way past it is `--no-verify`. So every other file `next typegen` writes
 * stays out. `validator.ts` imports every route and would typecheck the whole
 * app on every commit. `link.d.ts`, written because `typedRoutes` is on,
 * narrows every `href` to the union of known routes.
 *
 * @param {string} pkgDir
 * @param {{ scripts?: Record<string, string> }} pkgJson
 * @param {{ exists: (p: string) => boolean }} io
 * @returns {string[]}
 */
export function generatedDeclarations(pkgDir, pkgJson, { exists }) {
  if (!runsNextTypegen(pkgJson)) return [];
  const candidates = ["next-env.d.ts", ROUTE_TYPES];
  return candidates.filter((file) => exists(join(pkgDir, file)));
}

/**
 * The temporary tsconfig for one package group. `files` is the staged set
 * plus any generated declarations; `include` stays scoped to ambient
 * `.d.ts` files, so tsc checks the staged files and their import closure and
 * never the whole package.
 *
 * @param {string[]} stagedFiles package-relative paths of the staged files
 * @param {string[]} declarations package-relative generated declarations
 */
export function stagedConfig(stagedFiles, declarations = []) {
  return {
    extends: "./tsconfig.json",
    // `declaration` off, always. This hook typechecks; it never emits. With
    // `declaration: true` (tsconfig.base sets it, and only some packages
    // override it) tsc additionally reports declaration-emit PORTABILITY
    // diagnostics — chiefly TS2883, "the inferred type of X cannot be named
    // without a reference to <some type> ... A type annotation is necessary."
    // Whether a type is nameable depends on what else is in the program, and
    // this config narrows the program to the staged files, so the same source
    // that is clean under the package's real `include` reports TS2883 here.
    // A merge stages every incoming file, which is how one ordinary merge
    // commit produced ~40 of these against apps/app_deprecated while
    // `turbo run typecheck --filter=@oxagen/app-deprecated` was green — a
    // hook that fails open, because the way past it is `--no-verify`, which
    // skips the format, lint and atlas checks too. Declaration portability
    // is a property of the real build and CI typechecks the real build.
    compilerOptions: {
      noEmit: true,
      declaration: false,
      declarationMap: false,
    },
    files: [
      ...stagedFiles,
      ...declarations.filter((d) => !stagedFiles.includes(d)),
    ],
    // Load only ambient declaration files (next-env.d.ts, src/types/*.d.ts,
    // etc.) on top of `files` — NOT the whole source tree. Carries the global
    // module declarations + augmentations that side-effect imports and global
    // type extensions depend on, without re-typechecking every package file.
    include: ["**/*.d.ts"],
  };
}
