// The work read (`get_run_work`): the checkouts the run was recorded in, the
// pull requests on them with their checks and diffs, and the diffs the
// recorder captured. The page starts it once and hands the promise to the
// three places that draw it (the header's checkout strip, the side column's
// Changes panel and the Issues tab's Linked work), so they read one answer
// and provider latency never holds the rest of the page.
import type { RunWork } from "@/data/contracts/run-work";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import type { WsCtx } from "@/server/viewer";

/** Starts the read without waiting on it; a read that throws answers as the page's read error. */
export function readRunWork(
  ctx: WsCtx,
  source: DataSource,
  runId: string,
): Promise<Read<RunWork>> {
  return source.runs
    .work(ctx, runId)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
}
