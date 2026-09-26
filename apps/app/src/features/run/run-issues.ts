// The issues read (`get_run_issues`, #3970): the run's task, the issues its
// recorded pull requests close, and the issues its frames name, each with its
// state on GitHub now. The page starts it once, beside the work read, and
// hands the promise to the two places that draw it (the Issues tab's count
// in the tab strip and the Issues table), so they read one answer and a slow
// tracker read never holds the rest of the page.
import type { RunIssues } from "@/data/contracts/run-issues";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import type { WsCtx } from "@/server/viewer";

/** Starts the read without waiting on it; a read that throws answers as the page's read error. */
export function readRunIssues(
  ctx: WsCtx,
  source: DataSource,
  runId: string,
): Promise<Read<RunIssues>> {
  return source.runs
    .issues(ctx, runId)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
}
