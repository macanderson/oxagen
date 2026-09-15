// Fleet (ARCHITECTURE.md §1.2): the two-tile stat strip, the approvals panel
// and the runs table, from one list_runs page and the pending approvals. The
// tiles count the same reads the sections render, so a figure can never
// disagree with the rows under it.
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { ApprovalsPanel } from "./approvals-panel";
import { RunsTable } from "./runs-table";
import { StatStrip } from "./stat-strip";

async function readFleet(
  ctx: WsCtx,
  source: DataSource,
  cursor: string | null,
) {
  const [runs, approvals] = await Promise.all([
    source.runs.list(ctx, { cursor }),
    source.approvals.pending(ctx, { runId: null }),
  ]);
  // The approval clocks start from the instant the reads returned.
  return { runs, approvals, now: Date.now() };
}

export async function Fleet({
  ctx,
  source,
  cursor,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The runs page the URL asked for; null is the newest. */
  cursor: string | null;
}) {
  const { runs, approvals, now } = await readFleet(ctx, source, cursor);
  return (
    <div className="flex flex-col gap-6">
      <StatStrip runs={runs} approvals={approvals} now={now} />
      <ApprovalsPanel
        approvals={approvals}
        now={now}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
      />
      <RunsTable
        runs={runs}
        cursor={cursor}
        workspace={ctx.wsName}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
      />
    </div>
  );
}
