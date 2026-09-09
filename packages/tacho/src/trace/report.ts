export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  evidence: string;
}

export interface TraceReport {
  target: string;
  checks: CheckResult[];
}

export function pass(name: string, evidence: string): CheckResult {
  return { name, status: "pass", evidence };
}

export function fail(name: string, evidence: string): CheckResult {
  return { name, status: "fail", evidence };
}

export function skip(name: string, evidence: string): CheckResult {
  return { name, status: "skipped", evidence };
}

export function fromViolations(
  name: string,
  violations: string[],
  passEvidence: string,
): CheckResult {
  return violations.length === 0
    ? pass(name, passEvidence)
    : fail(name, violations.join("; "));
}

/** True when no check failed; skips do not fail a run. */
export function reportPassed(report: TraceReport): boolean {
  return report.checks.every((check) => check.status !== "fail");
}
