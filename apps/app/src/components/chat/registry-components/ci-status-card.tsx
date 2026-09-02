"use client";

import type { ReactElement } from "react";
import { CircleDot } from "lucide-react";
import {
  CiStatusSummary,
  type CiCounts,
  type CiRun,
  type CiOverall,
} from "./ci-status-summary";

/**
 * ci-status-card — the generic CI status card fed by `repo.ci.status`.
 *
 * componentId: "ci-status"
 *
 * Props are the FULL `repo.ci.status` output (flat, component-specific), so
 * this card owns the `ref`/short-sha header and delegates the run roll-up to
 * the shared `<CiStatusSummary />` (which the pr-stats card reuses verbatim).
 */

export interface CiStatus {
  ref: string;
  sha: string | null;
  overall: CiOverall;
  counts: CiCounts;
  runs: CiRun[];
}

export type CiStatusCardProps = CiStatus;

/** GitHub-style 7-char short sha. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export default function CiStatusCard({
  ref,
  sha,
  overall,
  counts,
  runs,
}: CiStatusCardProps): ReactElement {
  return (
    <div
      className="my-2 rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="ci-status-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <CircleDot
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
          title={ref}
        >
          {ref}
          {sha ? (
            <span className="ml-1.5 text-muted-foreground">
              ({shortSha(sha)})
            </span>
          ) : null}
        </span>
      </div>

      <div className="px-4 py-3">
        {runs.length > 0 ? (
          <CiStatusSummary overall={overall} counts={counts} runs={runs} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No CI checks reported for this ref.
          </p>
        )}
      </div>
    </div>
  );
}
