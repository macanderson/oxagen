/**
 * Eval report generation — produces human-readable and CI-parsable output.
 */
import type { EvalSuiteResult } from "./harness";

/**
 * Generate a text report for terminal output.
 */
export function generateTextReport(result: EvalSuiteResult): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════");
  lines.push("             * OXAGEN EVAL REPORT *                ");
  lines.push("═══════════════════════════════════════════════════");
  lines.push("");
  lines.push(
    `  Traces: ${result.totalTraces} | Passed: ${result.passed} | Failed: ${result.failed}`,
  );
  lines.push(`  Overall: ${result.overallPassed ? "✓ PASS" : "✗ FAIL"}`);
  lines.push("");

  for (const r of result.results) {
    const icon = r.passed ? "✓" : "✗";
    lines.push(`  ${icon} ${r.traceName}`);
    lines.push(
      `    Precision: ${(r.metrics.contextPrecision * 100).toFixed(1)}% | Recall: ${(r.metrics.contextRecall * 100).toFixed(1)}%`,
    );

    if (r.regressions.length > 0) {
      for (const reg of r.regressions) {
        lines.push(
          `    ⚠ ${reg.metric}: ${(reg.degradation * 100).toFixed(1)}% regression (${reg.baseline.toFixed(3)} → ${reg.current.toFixed(3)})`,
        );
      }
    }

    const failedTurns = r.turnResults.filter((t) => !t.pass);
    if (failedTurns.length > 0) {
      lines.push(`    ${failedTurns.length} turn(s) failed validation`);
    }
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════");
  return lines.join("\n");
}

/**
 * Generate a JSON report for CI tooling.
 */
export function generateJsonReport(result: EvalSuiteResult): string {
  return JSON.stringify(
    {
      passed: result.overallPassed,
      totalTraces: result.totalTraces,
      passedTraces: result.passed,
      failedTraces: result.failed,
      traces: result.results.map((r) => ({
        id: r.traceId,
        name: r.traceName,
        passed: r.passed,
        metrics: r.metrics,
        regressions: r.regressions,
      })),
    },
    null,
    2,
  );
}
