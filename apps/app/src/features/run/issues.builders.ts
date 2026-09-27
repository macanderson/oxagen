// Builders for the Issues tab's read (`get_run_issues`, #3970): one issue row
// and the whole answer, each with the fields a test does not care about set
// to the demo run's values (pages/run.md, Issues: `a-intel/platform#482`,
// the task, stated).
import type { RunIssues } from "@/data/contracts/run-issues";

export type RunIssueRow = RunIssues["issues"][number];

const PLATFORM = {
  host: "github.com",
  owner: "a-intel",
  name: "platform",
  url: "https://github.com/a-intel/platform",
  connected: true,
};

/** One issue row: the demo run's task, read open on GitHub. */
export function runIssue(overrides: Partial<RunIssueRow> = {}): RunIssueRow {
  return {
    ref: "a-intel/platform#482",
    repository: PLATFORM,
    number: 482,
    title: "Release notes for 4.11.0",
    status: "open",
    statusRead: "read",
    readAt: "2026-09-26T10:00:00.000Z",
    relation: "task",
    resolvedBy: [],
    actions: [],
    edge: "stated",
    frameSeqs: [],
    url: "https://github.com/a-intel/platform/issues/482",
    ...overrides,
  };
}

/** The answer, the demo run's task alone unless the test names the rows. */
export function runIssues(overrides: Partial<RunIssues> = {}): RunIssues {
  return {
    runId: "tse_7k2m9q",
    issues: [runIssue()],
    complete: true,
    warnings: [],
    ...overrides,
  };
}
