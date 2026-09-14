#!/usr/bin/env node
/**
 * A declared coverage threshold has to be able to fail.
 *
 * `@oxagen/tenancy` declared `thresholds: { lines: 90, branches: 85, … }` in its
 * `vitest.config.ts` and shipped no `test:coverage` script and no coverage
 * provider. Turbo runs `test:coverage`, so there was no task to run: the
 * thresholds were four numbers nothing read. A reader opening that file saw a
 * package held to 90% and it was held to nothing (#2635).
 *
 * That is worse than having no threshold. A missing gate is visible; a gate that
 * cannot fire reads as a gate.
 *
 * A package is required to have all three, or none:
 *
 *   1. `thresholds` in its vitest config
 *   2. a `test:coverage` script, so turbo has a task
 *   3. `@vitest/coverage-v8`, so that task can resolve a provider
 *
 * Two of three is the failure. Declaring none is fine — a package may
 * legitimately not gate on coverage, and this says nothing about that choice.
 *
 * A fourth fact ties the unit suite to the same task. PR CI's `test` job
 * (`.github/workflows/pipeline.yml`) runs `turbo run test:coverage` and not
 * `test:unit`, so a package with a `test:unit` script and no `test:coverage`
 * script has a suite no PR runs. `@oxagen/desktop` shipped that way: its
 * `vitest run` covered `src/commands.test.ts` on the nightly matrix only. A
 * `test:unit` script therefore requires a `test:coverage` script.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages", "apps", "tools"];
const PROVIDER = "@vitest/coverage-v8";

/** The four facts, for one package directory. */
export function inspect(dir, read = readFileSync, exists = existsSync) {
  const pkgPath = join(dir, "package.json");
  if (!exists(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(read(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const configPath = [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
  ]
    .map((f) => join(dir, f))
    .find((f) => exists(f));

  const config = configPath ? read(configPath, "utf8") : "";
  return {
    name: pkg.name ?? dir,
    dir,
    declaresThresholds: /thresholds\s*:/.test(config),
    hasScript: typeof pkg.scripts?.["test:coverage"] === "string",
    hasUnitScript: typeof pkg.scripts?.["test:unit"] === "string",
    hasProvider:
      PROVIDER in (pkg.devDependencies ?? {}) ||
      PROVIDER in (pkg.dependencies ?? {}),
  };
}

/** What is wrong with one package, or nothing. */
export function verdict(facts) {
  if (!facts) return null;
  const { declaresThresholds, hasScript, hasUnitScript, hasProvider } = facts;
  const missing = [];
  if (!hasScript) {
    if (hasUnitScript)
      missing.push(
        'a "test:coverage" script — PR CI runs test:coverage, so the "test:unit" suite gates nothing',
      );
    else if (declaresThresholds)
      missing.push('a "test:coverage" script — turbo has no task to run');
  }
  if (declaresThresholds && !hasProvider)
    missing.push(
      `a ${PROVIDER} dependency — the task cannot resolve a provider`,
    );
  else if (hasScript && !hasProvider)
    missing.push(
      `a ${PROVIDER} dependency — its "test:coverage" script cannot run`,
    );
  return missing.length > 0
    ? { name: facts.name, dir: facts.dir, missing }
    : null;
}

function main() {
  const problems = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = verdict(inspect(join(root, entry.name)));
      if (found) problems.push(found);
    }
  }

  if (problems.length === 0) {
    console.log(
      "[coverage-gates] every unit suite and declared threshold has a test:coverage task that can fail it",
    );
    return;
  }

  console.error(
    "[coverage-gates] a unit suite or declared threshold has no test:coverage task to fail it:\n",
  );
  for (const p of problems) {
    console.error(`  ${p.name} (${p.dir})`);
    for (const m of p.missing) console.error(`    missing ${m}`);
  }
  console.error(
    "\nAdd what is missing, or remove the thresholds. Four numbers nothing reads",
  );
  console.error(
    "are worse than no numbers: they read as a gate. A test:unit script",
  );
  console.error("with no test:coverage script is a suite PR CI never runs.");
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) main();
