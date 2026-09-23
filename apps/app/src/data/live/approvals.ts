// The approvals port on the kernel (ARCHITECTURE.md §3.3): the pending
// approvals of the workspace, or of one run, from list_approvals, a
// noBillingGate read.
//
// `pending` reads one page and the queue's count. `list_approvals` counts the
// whole pending queue beside every page (#3521), so the Fleet waiting tile and
// the panel header print an exact figure without walking the cursor. Walking
// it cost up to ten serial kernel reads before Fleet could render, and the
// panel then mounted a card, each with its own decision dialog, for every row
// the walk took. The panel draws the page it has and says when the queue holds
// more.
//
// `resolved` still walks: the Run page's resolved list has no count of its own
// to read, and it says when its bound stopped the walk (#3477).
import "server-only";
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { captureError } from "@oxagen/telemetry";
import { z } from "zod";
import {
  ApprovalQueue,
  ResolvedApprovalItem,
  ResolvedApprovalLedger,
} from "@/data/contracts/approvals";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toApprovalItems, toResolvedApprovalItems } from "./mappers/approvals";

/**
 * The rows one page carries: the contracts' own ceiling. For `pending` it is
 * also the most approval cards a panel mounts.
 */
export const PAGE_SIZE = 100;
/**
 * How many pages `approvals.resolved` walks before it stops (#3153, 10 *
 * PAGE_SIZE = 1,000 rows). The ledger says `more` when the bound stopped the
 * walk, so the panel can say the list is partial (#3477).
 */
const MAX_RESOLVED_PAGES = 10;

export const approvals: DataSource["approvals"] = {
  async pending(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: agentApprovalList,
      input: {
        ...(q.runId === null ? {} : { runId: q.runId }),
        limit: PAGE_SIZE,
      },
      page: q.runId === null ? "fleet" : "run",
    });
    if (!read.ok) return read;
    const items = toApprovalItems(read.value);
    // The count and the page are two statements, so a call parked or answered
    // between them can leave the count short of the page by a row. The page is
    // what the panel draws, so the count never reads lower than it.
    const total = Math.max(read.value.total, items.length);
    const view = ApprovalQueue.safeParse({
      items,
      total,
      more: read.value.nextCursor !== null || total > items.length,
    });
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "approvals.pending record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },
  // list_resolved_approvals, narrowed to one run: the Run page's Approvals tab
  // reads back the row `autoApprovePath` writes when a decision rule releases
  // a call with no person, which `pending` above can never show (#3153).
  //
  // The Run page draws every resolved approval for the run in one flat list
  // with no pager of its own, so this walks every page the contract hands
  // back rather than stopping at the first: a run with more than PAGE_SIZE
  // resolved calls would otherwise silently show only the newest 100 as if
  // that were the whole ledger. Bounded at MAX_RESOLVED_PAGES: a run holding
  // that many resolved approvals is far outside what the page renders
  // usefully, so the read stops there rather than growing unbounded. When the
  // last page the bound allows still carries a cursor, the ledger says `more`
  // instead of dropping that cursor and reading as complete (#3477).
  async resolved(ctx, q) {
    const items: z.input<typeof ResolvedApprovalItem>[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < MAX_RESOLVED_PAGES; page += 1) {
      const read = await kernelRead(ctx, {
        contract: agentApprovalListResolved,
        input: { runId: q.runId, limit: PAGE_SIZE, cursor },
        page: "run",
      });
      if (!read.ok) return read;
      items.push(...toResolvedApprovalItems(read.value));
      if (read.value.nextCursor === null) break;
      cursor = read.value.nextCursor;
      // The last page the bound allows still carried a cursor, so the run
      // holds resolved approvals this read did not take.
      more = page === MAX_RESOLVED_PAGES - 1;
    }
    const view = ResolvedApprovalLedger.safeParse({ items, more });
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "approvals.resolved record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },
};
