// The Policy tab (ARCHITECTURE.md §1.2 Run row; maintainer decision 8 of
// 2026-09-15): the calls this run parked for a human, from `list_approvals`
// narrowed to the run.
//
// The cards are the Fleet panel's, imported from that feature's public
// surface, so an approval reads the same on both pages and the mandate bar has
// one implementation. A card whose call drew on a mandate carries what the
// ledger recorded; the mandate read is made only when a parked call names one,
// so a run whose approvals draw on none makes no second read.
//
// The mockup's Policy tab also draws the rules that decided each call and the
// auto-approvals in force. Neither has a contract that reads them per run, so
// neither is drawn (§3.6); #2958 owns them.
import { useTranslations } from "next-intl";
import type { ApprovalItem } from "@/data/contracts/approvals";
import type { MandateRow } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { ApprovalsPanel } from "@/features/fleet";
import type { WsCtx } from "@/server/viewer";

export type RunApprovals = {
  approvals: Read<ApprovalItem[]>;
  /** The mandates the cards name, by public id; empty when none was read. */
  mandates: ReadonlyMap<string, MandateRow>;
  /** The instant the reads returned; a card's countdown starts there. */
  now: number;
};

/**
 * The run's parked calls, and the mandates they name when the viewer may read
 * the ledger. The clock starts when the reads returned, so the section is pure
 * of `Date.now()` and a countdown cannot disagree with the row beside it.
 */
export async function readRunApprovals(
  ctx: WsCtx,
  source: DataSource,
  runId: string,
): Promise<RunApprovals> {
  const approvals = await source.approvals.pending(ctx, { runId });
  const named =
    approvals.ok && approvals.value.some((item) => item.mandateId !== null);
  const mandates = new Map<string, MandateRow>();
  if (named) {
    const read = await source.mandates.list(ctx, { agentId: null });
    if (read.ok) {
      for (const mandate of read.value.mandates) {
        mandates.set(mandate.id, mandate);
      }
    }
  }
  return { approvals, mandates, now: Date.now() };
}

export function PolicySection({
  read,
  org,
  ws,
}: {
  read: RunApprovals;
  org: string;
  ws: string;
}) {
  const t = useTranslations("run.policy");
  return (
    <div className="flex flex-col gap-3">
      <ApprovalsPanel
        approvals={read.approvals}
        mandates={read.mandates}
        now={read.now}
        org={org}
        ws={ws}
        on="run"
      />
      <p className="max-w-prose text-xs text-muted-foreground">{t("basis")}</p>
    </div>
  );
}
