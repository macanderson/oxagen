// Writes apps/app/hardcoded-values-baseline.json from the tree (INV-37,
// src/test/arch/hardcoded-values.ts). Run it from apps/app after a change
// that replaces hard-coded values with tokens:
//
//   pnpm gen:hardcoded-values           write the baseline, or refuse when it would grow
//   pnpm gen:hardcoded-values --grow    write it even when it grows
//
// The baseline only shrinks. The script keeps each documented exception's
// reason, counts every other value the scan finds, and drops what the scan no
// longer finds. When the tree holds a value the baseline does not allow, it
// prints each one and writes nothing: replace the value with a token. Pass
// `--grow` only when code moved between files and took its values along, and
// say so in the pull request. To document an exception, replace its count in
// the file with the reason, and the script keeps it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Baseline,
  baselineFor,
  diffBaseline,
  parseBaseline,
  scanTree,
} from "../src/test/arch/hardcoded-values";

/** Where the baseline lives, relative to the app directory. */
export const BASELINE_FILE = "hardcoded-values-baseline.json";

/** Writes the baseline, or refuses when it would grow; returns the exit code. */
export function run(args: readonly string[], appDir: string): number {
  const file = path.join(appDir, BASELINE_FILE);
  const current: Baseline = existsSync(file)
    ? parseBaseline(readFileSync(file, "utf8"))
    : {};
  const findings = scanTree();
  if (existsSync(file) && !args.includes("--grow")) {
    const { added } = diffBaseline(findings, current);
    if (added.length > 0) {
      console.error(
        `The tree holds ${String(added.length)} hard-coded values ${BASELINE_FILE} does not allow. Replace each with a token:`,
      );
      for (const entry of added) console.error(`  + ${entry}`);
      return 1;
    }
  }
  writeFileSync(
    file,
    `${JSON.stringify(baselineFor(findings, current), null, 2)}\n`,
  );
  console.log(
    `Wrote ${BASELINE_FILE}: ${String(findings.length)} hard-coded values.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = run(
    process.argv.slice(2),
    fileURLToPath(new URL("..", import.meta.url)),
  );
}
