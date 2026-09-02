"use client";

import type { ReactElement } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";

/**
 * ci-status-summary — SHARED presentational summary of a CI run set.
 *
 * Consumed by BOTH the generic `ci-status` card and the `pr-stats` card's
 * "Checks" section, so it takes ONLY the CI shape's `{ overall, counts, runs }`
 * (the `ref`/`sha` a full `repo.ci.status` result also carries are optional and
 * rendered by the parent card header, not here). Keeping this self-contained
 * means the two cards stay pixel-identical for the CI portion without either
 * owning the other's markup.
 */

/** CI conclusion for a single run — mirrors the GitHub check-run conclusion set. */
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

/** Lifecycle status for a single run. */
export type CiRunStatus = "queued" | "in_progress" | "completed";

/** Roll-up verdict across all runs for a ref. */
export type CiOverall =
  | "passing"
  | "failing"
  | "pending"
  | "neutral"
  | "unknown";

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

/** The subset of `repo.ci.status` this component renders — ref/sha excluded. */
export interface CiStatusSummaryProps {
  overall: CiOverall;
  counts: CiCounts;
  runs: CiRun[];
}

/**
 * Format a run duration as `mm:ss` for a minute or more, or `1.2s` below a
 * minute. Self-contained — no date library is pulled into this lazy chunk.
 *
 * Intentionally distinct from the canonical `formatDuration` in `@/lib/utils`:
 * CI runs read as clock time ("12:34"), not "12m 34s".
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 0) return "0.0s";
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const OVERALL_META: Record<
  CiOverall,
  { textClass: string; label: string; spin: boolean }
> = {
  passing: { textClass: "text-success", label: "Passing", spin: false },
  failing: { textClass: "text-destructive", label: "Failing", spin: false },
  pending: { textClass: "text-warning", label: "Pending", spin: true },
  neutral: {
    textClass: "text-muted-foreground",
    label: "Neutral",
    spin: false,
  },
  unknown: {
    textClass: "text-muted-foreground",
    label: "Unknown",
    spin: false,
  },
};

/** Icon + colour for a single run row, keyed on lifecycle + conclusion. */
function RunGlyph({ run }: { run: CiRun }): ReactElement {
  if (run.status !== "completed") {
    // queued / in_progress
    return (
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-warning"
        aria-label={run.status === "queued" ? "Queued" : "In progress"}
      />
    );
  }
  switch (run.conclusion) {
    case "success":
      return (
        <CheckCircle2
          className="size-3.5 shrink-0 text-success"
          aria-label="Success"
        />
      );
    case "failure":
    case "timed_out":
    case "cancelled":
    case "action_required":
      return (
        <XCircle
          className="size-3.5 shrink-0 text-error"
          aria-label="Failure"
        />
      );
    default:
      // skipped / neutral / stale / null
      return (
        <MinusCircle
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label="Skipped"
        />
      );
  }
}

/** Build a compact counts line, omitting zero categories. */
function countsLine(counts: CiCounts): string {
  const parts: string[] = [];
  if (counts.passed > 0) parts.push(`${counts.passed} passed`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.neutral > 0) parts.push(`${counts.neutral} neutral`);
  return parts.join(" · ");
}

export function CiStatusSummary({
  overall,
  counts,
  runs,
}: CiStatusSummaryProps): ReactElement {
  const meta = OVERALL_META[overall];
  const line = countsLine(counts);

  return (
    <div className="flex flex-col gap-2" data-component="ci-status-summary">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs font-medium",
            meta.textClass,
          )}
        >
          {meta.spin ? (
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          ) : null}
          {meta.label}
        </span>
        {line ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {line}
          </span>
        ) : null}
      </div>

      {runs.length > 0 ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span>
              {runs.length} check{runs.length === 1 ? "" : "s"}
            </span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/60 pt-2">
            {runs.map((run, i) => {
              // `run.url` reaches us through capability output, so the scheme is
              // allow-listed before it becomes an href — an unsafe value drops
              // the link rather than arming a `javascript:` navigation.
              const runHref = safeHref(run.url);
              return (
                <li
                  key={`${run.name}-${i}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <RunGlyph run={run} />
                  <span
                    className="min-w-0 flex-1 truncate text-foreground"
                    title={run.name}
                  >
                    {run.name}
                  </span>
                  {run.app ? (
                    <span className="shrink-0 text-muted-foreground">
                      {run.app}
                    </span>
                  ) : null}
                  {run.durationMs !== null ? (
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatDuration(run.durationMs)}
                    </span>
                  ) : null}
                  {runHref ? (
                    <a
                      href={runHref}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`View ${run.name} check`}
                      className={cn(
                        "shrink-0 rounded p-0.5 text-muted-foreground transition-colors",
                        "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                    >
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
