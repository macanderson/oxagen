// Which component files are reachable ONLY from routes that Appendix F deletes?
// Those are the safe deletions. Anything reachable from a surviving route stays,
// however feature-shaped its directory name looks.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const APP = process.argv[2];
const ROUTES = JSON.parse(readFileSync(process.argv[3], "utf8"));
const OUT = process.argv[4];

const SRC = join(APP, "src");
const files = execSync(`fd -e ts -e tsx . ${SRC}`, { encoding: "utf8" }).trim().split("\n");
const fileSet = new Set(files);

// Resolve an import specifier to a file in the tree.
function resolveSpec(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // package import
  for (const cand of [
    base, `${base}.ts`, `${base}.tsx`,
    join(base, "index.ts"), join(base, "index.tsx"),
  ]) {
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

const IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']/g;
const edges = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const out = new Set();
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const r = resolveSpec(f, m[1]);
    if (r && r !== f) out.add(r);
  }
  edges.set(f, [...out]);
}

// Walk from a set of entry points.
function reach(entries) {
  const seen = new Set(entries);
  const stack = [...entries];
  while (stack.length) {
    for (const next of edges.get(stack.pop()) ?? []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return seen;
}

const survivingVerdicts = new Set(["exempt"]);
// A route survives if it is sign-in/callback, or it IS one of the ten pages.
// Everything Appendix F marks "absorbed" is a route file that goes away — but the
// page that absorbs it stays, so treat the absorbing page's own route as surviving.
const TEN = [
  "[orgSlug]/[workspaceSlug]", "[orgSlug]/[workspaceSlug]/runs",
  "[orgSlug]/[workspaceSlug]/agents", "[orgSlug]/[workspaceSlug]/tools",
  "[orgSlug]/[workspaceSlug]/ontology", "[orgSlug]/[workspaceSlug]/steering",
  "[orgSlug]/[workspaceSlug]/spend", "[orgSlug]", "[orgSlug]/billing", "[orgSlug]/audit",
];

const surviving = [], dying = [];
for (const r of ROUTES.classified) {
  const isTen = TEN.some((t) => r.route === t);
  (survivingVerdicts.has(r.verdict) || isTen ? surviving : dying).push(r.file);
}

// Layouts, middleware, providers and error boundaries are always entry points.
const infra = files.filter((f) =>
  /\/(layout|template|error|not-found|loading|global-error|middleware|route)\.tsx?$/.test(f),
);

const keepRoots = [...surviving, ...infra].filter((f) => fileSet.has(f));
const keep = reach(keepRoots);
const dyingReach = reach(dying.filter((f) => fileSet.has(f)));

const onlyDying = [...dyingReach].filter((f) => !keep.has(f));
const orphan = files.filter((f) => !keep.has(f) && !dyingReach.has(f));

const loc = (list) => {
  let n = 0;
  for (const f of list) n += readFileSync(f, "utf8").split("\n").length;
  return n;
};

writeFileSync(OUT, JSON.stringify({ onlyDying, orphan, keep: [...keep] }, null, 2));

console.log(`files in apps/app/src:            ${files.length}  (${loc(files)} LOC)`);
console.log(`surviving route entry points:     ${keepRoots.length}`);
console.log(``);
console.log(`reachable from a survivor (KEEP): ${keep.size}  (${loc([...keep])} LOC)`);
console.log(`reachable ONLY from dying routes: ${onlyDying.length}  (${loc(onlyDying)} LOC)  <- safe delete`);
console.log(`reachable from nothing (orphan):  ${orphan.length}  (${loc(orphan)} LOC)  <- already dead`);

const dirOf = (f) => (f.replace(`${SRC}/`, "").split("/").slice(0, 2).join("/"));
const byDir = {};
for (const f of onlyDying) byDir[dirOf(f)] = (byDir[dirOf(f)] ?? 0) + 1;
console.log(`\n--- safe-delete files by directory ---`);
for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 22)) {
  console.log(`  ${String(n).padStart(4)}  ${d}`);
}
