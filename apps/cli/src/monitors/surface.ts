/**
 * The default report surfacer (pipeline Group 5, deliverable 3's seam).
 *
 * A background monitor's report must reach the developer proactively — the
 * developer never has to ask for it. This is the minimal default
 * `onReport` handler: it writes a short, human-readable summary to stderr
 * (matching the terminal-output convention used elsewhere in the CLI, e.g.
 * `pipeline/survey.ts`'s `terminalPrompter`) so it appears in the session
 * without disturbing stdout. Group 6 wires this (or a richer TUI equivalent)
 * into the coordinator via `MonitorService.onReport(surfaceReport)`.
 */
import type { MonitorReport } from "./types.js";

/** Emit a monitor's terminal-state report to the developer, unprompted. */
export function surfaceReport(report: MonitorReport): void {
  const lines = [`\n[monitor] target=${report.targetId}: ${report.status}.`];
  if (report.status === "failed") {
    lines.push(
      report.identifiedProblem
        ? "  Identified the problem."
        : "  Could not identify the problem.",
    );
    lines.push(
      report.canFixWithCommittedChanges
        ? "  The changes already committed should fix it."
        : "  The changes already committed do not appear to fix it.",
    );
  }
  if (report.note) lines.push(`  ${report.note}`);
  process.stderr.write(`${lines.join("\n")}\n`);
}
