#!/usr/bin/env node
/**
 * relocate-lib-squatters.mjs — move single-importer lib/ modules next to their
 * only caller, rewriting every affected import specifier in the same pass.
 *
 * Locality-of-behavior codemod for the module-boundary restructuring: a module
 * whose only consumer is one page/component/command is not "shared" — it lives
 * with its caller. What it does:
 *
 *   1. Auto-detects each module's test files (co-located `<stem>.test.*` and
 *      `__tests__/<stem>.test.*`) and moves them along with it.
 *   2. Rewrites every specifier — static import/export-from, dynamic import(),
 *      require(), and vi.mock()/vi.doMock()/vi.unmock()/vi.importActual()/
 *      vi.importMock() — in the whole src tree whose RESOLUTION is affected:
 *      either it pointed at a moved file, or it is a relative specifier inside
 *      a moved file.
 *   3. Uses `git mv` so history follows the file.
 *
 * NOT ATOMIC. All inputs are validated up front (missing source / occupied
 * destination throw before anything is touched), but the execute phase writes
 * N files and then shells out to N `git mv` calls with no rollback: a failure
 * partway through leaves a half-migrated tree. Run `--dry` first, run it on a
 * clean tree, and recover with `git checkout`/`git reset` if it aborts.
 *
 * Rewrites are scoped to <srcRootRel>. Files OUTSIDE that tree that import a
 * moved module — e2e specs, next.config.ts, vitest.config.ts, another package —
 * are not rewritten and will break silently. Grep for the old paths afterwards.
 *
 * Specifiers are matched by regex, not parsed, so a specifier-shaped string
 * inside a comment or template literal can be rewritten too. Review the diff.
 *
 * Usage:
 *   node tools/codemods/relocate-lib-squatters.mjs <repoRoot> <srcRootRel> <alias|-> <moves.json> [--dry]
 *
 *   alias   "@" for apps/app (rewrites cross-dir specifiers to "@/…", keeps
 *           the extensionless convention); "-" for apps/cli (rewrites to
 *           relative ESM specifiers with the ".js" suffix convention).
 *   moves   JSON array of { "from": "<repo-rel .ts/.tsx>", "to": "<repo-rel>" }
 *           (main modules only — tests are found and mapped automatically).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const USAGE =
  "usage: relocate-lib-squatters.mjs <repoRoot> <srcRootRel> <alias|-> <moves.json> [--dry]";
const [, , repoRoot, srcRootRel, aliasArg, movesFile, ...restArgs] =
  process.argv;
if (!repoRoot || !srcRootRel || !aliasArg || !movesFile) {
  console.error(USAGE);
  process.exit(1);
}
// Anything after moves.json must be exactly `--dry` and nothing else. A typo
// (`--dry-run`, `-n`) must NOT silently fall through to a destructive run that
// rewrites files and shells out to `git mv`.
const unknownArgs = restArgs.filter((a) => a !== "--dry");
if (unknownArgs.length > 0 || restArgs.length > 1) {
  console.error(`unrecognized argument(s): ${restArgs.join(" ")}`);
  console.error(USAGE);
  process.exit(1);
}
const DRY = restArgs[0] === "--dry";
const alias = aliasArg === "-" ? null : aliasArg;
const srcRoot = path.join(repoRoot, srcRootRel);
const EXTS = [".ts", ".tsx"];

const abs = (rel) => path.join(repoRoot, rel);
const rel = (a) => path.relative(repoRoot, a);

// ── build the full move map (main files + their tests) ──────────────────────
const mainMoves = JSON.parse(fs.readFileSync(movesFile, "utf8"));
const moveMap = new Map(); // abs old → abs new
const claimedDests = new Set(); // abs new — catches two sources aimed at one path

// Every destination goes through here, so the "validated up front" guarantee in
// the header covers auto-detected test moves too. `git mv` refuses to clobber an
// existing path, so an unchecked collision would abort mid-run and leave the
// tree half-migrated — exactly the non-atomic failure this phase exists to avoid.
function planMove(fromRel, toRel) {
  if (fs.existsSync(abs(toRel)))
    throw new Error(`destination exists: ${toRel}`);
  if (claimedDests.has(abs(toRel)))
    throw new Error(`two sources target the same destination: ${toRel}`);
  claimedDests.add(abs(toRel));
  moveMap.set(abs(fromRel), abs(toRel));
}

for (const { from, to } of mainMoves) {
  if (!fs.existsSync(abs(from))) throw new Error(`missing source: ${from}`);
  planMove(from, to);
  const stem = path.basename(from).replace(/\.(ts|tsx)$/, "");
  const fromDir = path.dirname(from);
  const toDir = path.dirname(to);
  for (const ext of EXTS) {
    const co = path.join(fromDir, `${stem}.test${ext}`);
    if (fs.existsSync(abs(co)))
      planMove(co, path.join(toDir, `${stem}.test${ext}`));
    const under = path.join(fromDir, "__tests__", `${stem}.test${ext}`);
    if (fs.existsSync(abs(under)))
      planMove(under, path.join(toDir, "__tests__", `${stem}.test${ext}`));
  }
}

// ── scan the src tree ────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const SPEC_RE =
  /((?:import|export)[^'"`]*?from\s*|import\s*\(\s*|require\s*\(\s*|\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*)(["'])([^"']+)\2/g;

function resolveSpec(fromFile, spec) {
  let base = null;
  if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else if (alias && (spec === alias || spec.startsWith(alias + "/")))
    base = path.join(srcRoot, spec.slice(alias.length + 1));
  if (!base) return null;
  const m = base.match(/\.(m|c)?jsx?$/);
  const stem = m ? base.slice(0, -m[0].length) : base;
  const candidates = [
    base,
    stem + ".ts",
    stem + ".tsx",
    base + ".ts",
    base + ".tsx",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function newSpecifier(newImporter, newTarget, oldSpec) {
  if (alias) {
    // apps/app convention: same-dir stays relative, cross-dir goes through the
    // alias; both extensionless (Turbopack requires extensionless TS imports).
    const noExt = (p) => p.replace(/\.(ts|tsx)$/, "");
    if (path.dirname(newTarget) === path.dirname(newImporter))
      return "./" + noExt(path.basename(newTarget));
    return (
      alias +
      "/" +
      noExt(path.relative(srcRoot, newTarget)).split(path.sep).join("/")
    );
  }
  // apps/cli convention: relative ESM specifiers with a ".js" suffix.
  let r = path
    .relative(path.dirname(newImporter), newTarget)
    .split(path.sep)
    .join("/");
  r = r.replace(/\.(ts|tsx)$/, ".js");
  if (!r.startsWith(".")) r = "./" + r;
  // preserve extensionless style if the original specifier had no extension
  if (!/\.(m|c)?jsx?$/.test(oldSpec)) r = r.replace(/\.js$/, "");
  return r;
}

const files = walk(srcRoot);
const rewrites = []; // {file(old abs), content}
const mapReport = [];

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const fNew = moveMap.get(f) ?? f;
  let changed = false;
  const out = src.replace(SPEC_RE, (full, lead, quote, spec) => {
    const resolved = resolveSpec(f, spec);
    if (!resolved) return full;
    const targetNew = moveMap.get(resolved) ?? resolved;
    if (targetNew === resolved && fNew === f) return full; // untouched pair
    if (targetNew === resolved && !spec.startsWith(".")) return full; // alias spec, importer moved — still valid
    const next = newSpecifier(fNew, targetNew, spec);
    if (next === spec) return full;
    changed = true;
    return `${lead}${quote}${next}${quote}`;
  });
  if (changed) rewrites.push({ file: f, content: out });
}

// ── execute ──────────────────────────────────────────────────────────────────
for (const [from, to] of moveMap.entries())
  mapReport.push({ from: rel(from), to: rel(to) });
console.log(DRY ? "── DRY RUN — planned moves:" : "── moves:");
for (const m of mapReport) console.log(`  ${m.from}  →  ${m.to}`);
console.log(`── files with rewritten specifiers: ${rewrites.length}`);
for (const r of rewrites) console.log(`  ${rel(r.file)}`);

if (!DRY) {
  for (const r of rewrites) fs.writeFileSync(r.file, r.content);
  const done = [];
  for (const [from, to] of moveMap.entries()) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      execFileSync("git", ["mv", rel(from), rel(to)], { cwd: repoRoot });
      done.push(rel(to));
    } catch (err) {
      // There is no rollback: the specifier rewrites and every earlier `git mv`
      // are already on disk. Name exactly what landed so the tree can be reset.
      console.error(
        `── FAILED at ${rel(from)} → ${rel(to)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        `── partial state: ${rewrites.length} file(s) rewritten, ${done.length} move(s) applied.`,
      );
      console.error("── recover with: git reset && git checkout -- .");
      process.exit(1);
    }
  }
  console.log(
    "── done. Verify with the package's typecheck + the moved test files only.",
  );
}
