// INV-22 (ARCHITECTURE.md §4, §5): the production bundle carries no seed or
// demo data. After `next build`, this walks .next/server and .next/static and
// fails when a sentinel string appears in any file there. The sentinels are
// the seeded owner's domain (`e2e.oxagen.test`, apps/app/e2e/support) and the
// name reserved for local demo data (`demo-seed`); a server component that
// imports either lands in .next/server, a client one in .next/static.
//
// A Node walk, never `rg`: the CI image carries ripgrep, a developer machine
// may not (§2). Runs from apps/app: `node scripts/scan-build-sentinels.mjs`,
// or with the build directory as the first argument.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SENTINELS = ["e2e.oxagen.test", "demo-seed"];
export const SCANNED_DIRS = ["server", "static"];

/** Every file under `dir` (recursive), or none when the directory is absent. */
function filesUnder(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/**
 * `{ file, sentinel }` for every sentinel found in every file of the scanned
 * directories under `buildDir`. Files are read as latin1 so a binary asset is
 * scanned byte for byte rather than decoded.
 */
export function scanBuild(buildDir) {
  const hits = [];
  for (const sub of SCANNED_DIRS) {
    for (const file of filesUnder(path.join(buildDir, sub))) {
      const text = readFileSync(file, "latin1");
      for (const sentinel of SENTINELS) {
        if (text.includes(sentinel)) {
          hits.push({ file: path.relative(buildDir, file), sentinel });
        }
      }
    }
  }
  return hits;
}

function main() {
  const buildDir = path.resolve(process.argv[2] ?? ".next");
  const scanned = SCANNED_DIRS.map((sub) => path.join(buildDir, sub));
  const missing = scanned.filter((dir) => filesUnder(dir).length === 0);
  if (missing.length === SCANNED_DIRS.length) {
    console.error(
      `scan-build-sentinels: nothing to scan under ${buildDir} (run next build first)`,
    );
    process.exit(2);
  }
  const hits = scanBuild(buildDir);
  if (hits.length > 0) {
    console.error(
      "scan-build-sentinels: sentinel found in the production build",
    );
    for (const hit of hits) console.error(`  ${hit.file}: ${hit.sentinel}`);
    process.exit(1);
  }
  console.log(
    `scan-build-sentinels: no sentinel under ${scanned.map((d) => path.relative(buildDir, d)).join(", ")}`,
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
