import type { GitHubCiChecks } from "@oxagen/github";

// Shared shape for the `overall`/`counts`/`runs` subset of CiStatus. Both
// repo.ci.status (which adds ref/sha) and repo.pr.get (which embeds this as
// `ci`) build their CI payload from here so the derivation lives in one place.

export type CiOverall =
  | "passing"
  | "failing"
  | "pending"
  | "neutral"
  | "unknown";

export type CiRunStatus = "queued" | "in_progress" | "completed";

export type CiRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped"
  | "stale"
  | null;

export interface CiRun {
  name: string;
  status: CiRunStatus;
  conclusion: CiRunConclusion;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  app: string | null;
}

export interface CiCounts {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  neutral: number;
}

export interface CiSummary {
  overall: CiOverall;
  counts: CiCounts;
  runs: CiRun[];
}

// Conclusions that mark a check as an outright failure.
const FAILING_CONCLUSIONS = new Set<CiRunConclusion>([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
]);

function durationMs(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/**
 * Merge GitHub check runs and legacy commit statuses into the CiStatus
 * `runs` array, then derive `counts` and the `overall` verdict.
 */
export function buildCiSummary(checks: GitHubCiChecks): CiSummary {
  const runs: CiRun[] = [];

  for (const r of checks.checkRuns) {
    runs.push({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      url: r.detailsUrl,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      durationMs: durationMs(r.startedAt, r.completedAt),
      app: r.appName,
    });
  }

  for (const s of checks.statuses) {
    // Legacy statuses have no lifecycle status — derive it from state.
    const pending = s.state === "pending";
    const conclusion: CiRunConclusion = pending
      ? null
      : s.state === "success"
        ? "success"
        : "failure"; // both "failure" and "error" are failures
    const completedAt = pending ? null : s.updatedAt;
    runs.push({
      name: s.context,
      status: pending ? "in_progress" : "completed",
      conclusion,
      url: s.targetUrl,
      startedAt: s.createdAt,
      completedAt,
      durationMs: durationMs(s.createdAt, completedAt),
      app: null,
    });
  }

  const counts: CiCounts = {
    total: runs.length,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    neutral: 0,
  };

  for (const run of runs) {
    if (run.status !== "completed") {
      counts.pending += 1;
      continue;
    }
    if (run.conclusion === "success") counts.passed += 1;
    else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion))
      counts.failed += 1;
    else if (run.conclusion === "skipped") counts.skipped += 1;
    else counts.neutral += 1; // neutral, stale, or null-on-completed
  }

  const overall = deriveOverall(runs);

  return { overall, counts, runs };
}

function deriveOverall(runs: CiRun[]): CiOverall {
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.conclusion && FAILING_CONCLUSIONS.has(r.conclusion))) {
    return "failing";
  }
  if (runs.some((r) => r.status === "queued" || r.status === "in_progress")) {
    return "pending";
  }
  if (runs.every((r) => r.conclusion === "success")) return "passing";
  return "neutral";
}
