// Fleet (ARCHITECTURE.md §1.2): the two-tile stat strip, the approvals panel
// and the runs table, from one list_runs page and the pending approvals. The
// tiles count the same reads the sections render, so a figure can never
// disagree with the rows under it.
//
// The mandate ledger is read only when a parked call names a mandate (#2957),
// so a workspace whose approvals draw on none makes no third read, and a
// viewer who may not read the ledger sees the cards without their bars.
import type { ReactNode } from "react";
import type { MandateRow } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { canCommandRun } from "@/shared/run-command-roles";
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
  const named =
    approvals.ok &&
    approvals.value.items.some((item) => item.mandateId !== null);
  const mandates = new Map<string, MandateRow>();
  if (named) {
    const read = await source.mandates.list(ctx, { agentId: null });
    if (read.ok)
      for (const mandate of read.value.mandates)
        mandates.set(mandate.id, mandate);
  }
  // The approval clocks start from the instant the reads returned.
  return { runs, approvals, mandates, now: Date.now() };
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
  const { runs, approvals, mandates, now } = await readFleet(
    ctx,
    source,
    cursor,
  );
  return (
    <div className="flex flex-col gap-3.5">
      <StatStrip
        runs={runs}
        approvals={approvals}
        now={now}
        spendTiles={spendTiles}
      />
      <ApprovalsPanel
        approvals={approvals}
        mandates={mandates}
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
        canCommand={canCommandRun(ctx.orgRole, ctx.wsRole)}
      />
    </div>
  );
}
