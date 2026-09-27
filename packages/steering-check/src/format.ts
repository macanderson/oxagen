// format.ts: a report as a person reads it in a terminal or a PR comment, and
// as JSON for an agent or the server.
import type { CheckReport, CheckStatus, Finding } from "./types";

const STATUS_LABEL: Record<CheckStatus, string> = {
  passed: "PASS",
  warned: "WARN",
  failed: "FAIL",
  skipped: "SKIP",
};

/** Where a finding points, such as `workspace.toml:19 (tools.definition_budget)`. */
export function findingPlace(finding: Finding): string {
  const at = finding.path === "" ? "" : finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
  if (finding.field === null) return at;
  return at === "" ? `(${finding.field})` : `${at} (${finding.field})`;
}

function findingLines(finding: Finding): string[] {
  const place = findingPlace(finding);
  const head = `  ${finding.severity} ${finding.check}/${finding.rule}${place === "" ? "" : ` at ${place}`}`;
  return [head, `    ${finding.message}`, `    Expected: ${finding.expected}`, `    Fix: ${finding.fix}`];
}

function totals(report: CheckReport): string {
  const errors = report.findings.filter((finding) => finding.severity === "error").length;
  const warnings = report.findings.length - errors;
  const noun = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  return `${noun(errors, "error")} and ${noun(warnings, "warning")}`;
}

/**
 * The report as plain text: one line per check with its status and summary,
 * each finding under its check, then the result.
 */
export function formatHuman(report: CheckReport): string {
  const width = Math.max(...report.results.map((entry) => entry.check.length));
  const lines: string[] = [];
  for (const entry of report.results) {
    lines.push(`${STATUS_LABEL[entry.status]}  ${entry.check.padEnd(width)}  ${entry.summary}`);
    for (const finding of entry.findings) lines.push(...findingLines(finding));
  }
  lines.push("");
  lines.push(
    report.passed
      ? `The steering PR passes, with ${totals(report)}.`
      : `The steering PR does not pass: ${totals(report)}. Fix each error, then run the checks again.`,
  );
  return `${lines.join("\n")}\n`;
}

/** The report as JSON, in the shape `runChecks` returns. */
export function formatJson(report: CheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
