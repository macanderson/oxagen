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
 * `typecheck` script runs `next typegen` gets its route types generated once,
 * when they are missing, and the generated declarations are put in the
 * staged program. No other package is touched, and nothing is generated when
 * no staged file belongs to such a package.
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

/**
 * Whether the hook has to run `next typegen` for this package before tsc.
 * False when the package does not use generated route types, and false when
 * they are already on disk: the hook runs on every commit, and typegen loads
 * the whole Next config.
 *
 * @param {string} pkgDir absolute package directory
 * @param {{ scripts?: Record<string, string> }} pkgJson
 * @param {(p: string) => boolean} exists
 */
export function needsTypegen(pkgDir, pkgJson, exists) {
  return runsNextTypegen(pkgJson) && !exists(join(pkgDir, ROUTE_TYPES));
}

/**
 * The generated declaration files to add to the staged program, relative to
 * the package. `apps/app/tsconfig.json` excludes `.next`, and the temp
 * config's `include` inherits that `exclude`, so its `**\/*.d.ts` pattern never
 * reaches `.next/types`. Files named in `files` are not subject to `exclude`,
 * so they go there. Only the `.d.ts` files directly under `.next/types` are
 * taken: `validator.ts` beside them imports every route, and adding it would
 * typecheck the whole app on every commit.
 *
 * @param {string} pkgDir
 * @param {{ scripts?: Record<string, string> }} pkgJson
 * @param {{ exists: (p: string) => boolean, readdir: (p: string) => string[] }} io
 * @returns {string[]}
 */
export function generatedDeclarations(pkgDir, pkgJson, { exists, readdir }) {
  if (!runsNextTypegen(pkgJson)) return [];
  const out = [];
  if (exists(join(pkgDir, "next-env.d.ts"))) out.push("next-env.d.ts");
  const typesDir = join(pkgDir, ".next", "types");
  if (exists(typesDir)) {
    for (const name of readdir(typesDir).sort()) {
      if (name.endsWith(".d.ts")) out.push(`.next/types/${name}`);
    }
  }
  return out;
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
