#!/usr/bin/env node
/**
 * check-contracts.mjs — verify every contract file under a package's
 * src/contracts/ directory appears in that package's exported `contracts`
 * array (contracts/index.ts).
 *
 * OXA-1390, Phase 3.
 *
 * The structural IAM check lives inside defineContract() — there is no bypass
 * to guard against at the file level. This lighter guard catches the operational
 * mistake of adding a contract file but forgetting to add it to the contracts[]
 * array, which would exclude it from the seed migration and the Wave 5 UI.
 *
 * Exit codes:
 *   0 — all contract files appear in their package's contracts array.
 *   1 — one or more contract files are missing from the contracts array.
 *   2 — script error (missing directory, unreadable file, etc.).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const ROOT = resolve(process.cwd());
const PACKAGES_DIR = join(ROOT, "packages");

/**
 * Find all package directories that have a src/contracts/ subdirectory and
 * a src/contracts/index.ts file (the canonical contracts array).
 */
function findContractPackages() {
  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(PACKAGES_DIR, d.name));

  return dirs.filter((dir) => {
    const contractsDir = join(dir, "src", "contracts");
    const indexFile = join(contractsDir, "index.ts");
    return existsSync(contractsDir) && existsSync(indexFile);
  });
}

/**
 * List all non-test .ts files in a contracts/ directory, excluding index.ts.
 */
function listContractFiles(contractsDir) {
  return readdirSync(contractsDir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts",
  );
}

/**
 * Read the contracts/index.ts for a package and return the set of base names
 * (without extension) that appear in the import statements.
 *
 * We do static analysis on the import list rather than dynamic require(),
 * so this script stays fast and works without building the project.
 */
function readIndexImports(indexPath) {
  const src = readFileSync(indexPath, "utf8");
  const importedBases = new Set();
  // Match relative imports of a sibling contract module. The extension is
  // optional: this repo uses extensionless imports (TS "bundler" resolution),
  // but NodeNext-style ".js" specifiers are also accepted.
  //   from "./some.name"      -> some.name
  //   from "./some.name.js"   -> some.name
  const importRegex = /from\s+["']\.\/([^"']+?)(?:\.js)?["']/g;
  let m;
  while ((m = importRegex.exec(src)) !== null) {
    const baseName = m[1];
    if (baseName && baseName !== "index") {
      importedBases.add(baseName);
    }
  }
  return importedBases;
}

function main() {
  const packages = findContractPackages();

  // Zero packages is not "nothing to check" — this repo always has at least
  // packages/oxagen/src/contracts. An empty result means the layout moved (or
  // this ran from the wrong cwd), and reporting a pass would silently retire
  // the guard. Fail as a script error so the cause is fixed, not inherited.
  if (packages.length === 0) {
    console.error(
      `No packages with src/contracts/index.ts found under ${PACKAGES_DIR}.\n` +
        "Run this from the monorepo root; if the layout genuinely changed, update\n" +
        "findContractPackages() — do not let the check pass vacuously.",
    );
    process.exit(2);
  }

  const gaps = [];

  for (const pkgDir of packages) {
    const contractsDir = join(pkgDir, "src", "contracts");
    const indexPath = join(contractsDir, "index.ts");
    const pkgName = basename(pkgDir);

    const contractFiles = listContractFiles(contractsDir);
    const importedBases = readIndexImports(indexPath);

    for (const file of contractFiles) {
      const base = file.replace(/\.ts$/, "");
      if (!importedBases.has(base)) {
        gaps.push(
          `packages/${pkgName}/src/contracts/${file} — missing from contracts/index.ts imports`,
        );
      }
    }
  }

  if (gaps.length > 0) {
    console.error(
      "\nCONTRACTS ARRAY GAPS — contract files not exported in contracts/index.ts:",
    );
    for (const g of gaps) {
      console.error(`  - ${g}`);
    }
    console.error(
      "\nFix: add the missing import(s) to the package's src/contracts/index.ts and include",
    );
    console.error("     the exported symbol in the contracts[] array.");
    process.exit(1);
  }

  console.log(
    `check-contracts: ${packages.length} package(s) checked. All contract files are exported.`,
  );
  process.exit(0);
}

// Any unexpected throw (missing packages/, unreadable file) is a script error,
// which the header documents as exit 2 — without this it would surface as an
// uncaught exception and exit 1, indistinguishable from a real gap.
try {
  main();
} catch (error) {
  console.error(
    `check-contracts: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(2);
}
