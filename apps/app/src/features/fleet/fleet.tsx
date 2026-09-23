// Fleet keeps activity and run controls; the shell drawer owns approval decisions.
import type { ReactNode } from "react";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { canCommandRun } from "@/shared/run-command-roles";
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
  return { runs, approvals, now: Date.now() };
}

export async function Fleet({
  ctx,
  source,
  cursor,
  spendTiles,
}: {
  ctx: WsCtx;
  source: DataSource;
  spendTiles?: ReactNode;
  /** The runs page the URL asked for; null is the newest. */
  cursor: string | null;
}) {
  const { runs, approvals, now } = await readFleet(ctx, source, cursor);
  return (
    <div className="flex flex-col gap-3.5">
      <StatStrip
        runs={runs}
        approvals={approvals}
        now={now}
        spendTiles={spendTiles}
      />
      <RunsTable
        runs={runs}
        cursor={cursor}
        workspace={ctx.wsName}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
        canCommand={canCommandRun(ctx.orgRole, ctx.wsRole)}
      />
    </div>
  );
}
