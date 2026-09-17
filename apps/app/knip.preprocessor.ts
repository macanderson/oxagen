// knip preprocessor: applies the shrink-only baseline in knip-baseline.json.
//
// `knip --production --strict` (INV-16) lands while findings still exist, so
// the CI run carries a baseline the same way the arch tests carry
// src/test/arch/baseline.json: a finding listed in the baseline is dropped
// from the report, a finding not listed fails the run through knip's own exit
// code, and a baseline entry knip no longer reports is stale and fails the
// run too, so the file can only shrink. Wired through knip.json
// (`preprocessor`), which keeps the CI command exactly `knip --production
// --strict`.
//
// A baseline entry is one string per finding, `<type> <file> [<symbol>]`
// (see `keyOf`); a stale entry is printed in that form for removal.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Issue, IssueRecords, IssueType, ReporterOptions } from "knip";

export const BASELINE_FILE = "knip-baseline.json";

function keyOf(issue: Issue, cwd: string): string {
  const file = relative(cwd, issue.filePath);
  if (issue.type === "files") return `files ${file}`;
  const symbol = issue.symbols
    ? issue.symbols.map((s) => s.symbol).join(",")
    : issue.symbol;
  const name = issue.parentSymbol ? `${issue.parentSymbol}.${symbol}` : symbol;
  return `${issue.type} ${file} ${name}`;
}

function readBaseline(path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${BASELINE_FILE}: unreadable`, { cause });
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${BASELINE_FILE}: expected a JSON array of strings`);
  }
  const entries: string[] = parsed;
  const duplicates = entries.filter((entry, i) => entries.indexOf(entry) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `${BASELINE_FILE}: duplicate entries: ${duplicates.join(", ")}`,
    );
  }
  return entries;
}

function applyBaseline(
  data: ReporterOptions,
  baseline: readonly string[],
): { data: ReporterOptions; stale: string[] } {
  const remaining = new Set(baseline);
  const types = Object.keys(data.issues) as IssueType[];
  for (const type of types) {
    const kept: IssueRecords = {};
    for (const [filePath, byKey] of Object.entries(data.issues[type])) {
      for (const [key, issue] of Object.entries(byKey)) {
        if (remaining.delete(keyOf(issue, data.cwd))) {
          data.counters[type] -= 1;
          data.counters.total -= 1;
          continue;
        }
        (kept[filePath] ??= {})[key] = issue;
      }
    }
    data.issues[type] = kept;
  }
  const stale = [...remaining];
  if (stale.length > 0) {
    // knip derives its exit code from the counters of the reported error
    // types (dist/cli.js), so a stale entry counts against `files`, which
    // production mode always reports, without adding a row to that section.
    data.counters.files += stale.length;
    data.counters.total += stale.length;
  }
  return { data, stale };
}

export default function preprocessor(data: ReporterOptions): ReporterOptions {
  const baseline = readBaseline(join(data.cwd, BASELINE_FILE));
  const result = applyBaseline(data, baseline);
  if (result.stale.length > 0) {
    console.log(
      `Stale ${BASELINE_FILE} entries (${String(result.stale.length)}), remove them:`,
    );
    for (const entry of result.stale) console.log(`  ${entry}`);
  }
  return result.data;
}
