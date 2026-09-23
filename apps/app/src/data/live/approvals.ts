// The approvals port on the kernel (ARCHITECTURE.md §3.3): the pending
// approvals of the workspace, or of one run, from list_approvals, a
// noBillingGate read.
//
// Both reads walk the cursor to the end of their queue rather than stopping at
// the first page, because both feed a flat list with no pager of its own and
// the Fleet waiting tile counts what `pending` returns. One page read as the
// whole queue is a figure an operator would staff against: a workspace with
// 140 parked calls showed 100, said nothing, and looked settled.
import "server-only";
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { captureError } from "@oxagen/telemetry";
import { z } from "zod";
import {
  ApprovalItem,
  ApprovalQueue,
  ResolvedApprovalItem,
  ResolvedApprovalLedger,
} from "@/data/contracts/approvals";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toApprovalItems, toResolvedApprovalItems } from "./mappers/approvals";

const PAGE_SIZE = 100;
/**
 * How many pages `approvals.resolved` walks before it stops (#3153, 10 *
 * PAGE_SIZE = 1,000 rows). The ledger says `more` when the bound stopped the
 * walk, so the panel can say the list is partial (#3477).
 */
const MAX_RESOLVED_PAGES = 10;
/**
 * How many pages `approvals.pending` walks before it stops (10 * PAGE_SIZE =
 * 1,000 rows). A workspace holding more parked calls than that has a problem no
 * card list answers, so the read stops rather than growing unbounded, and the
 * queue says `more` so the tile can say so too.
 */
const MAX_PENDING_PAGES = 10;

export const approvals: DataSource["approvals"] = {
  async pending(ctx, q) {
    const items: z.input<typeof ApprovalItem>[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < MAX_PENDING_PAGES; page += 1) {
      const read = await kernelRead(ctx, {
        contract: agentApprovalList,
        input: {
          ...(q.runId === null ? {} : { runId: q.runId }),
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        page: q.runId === null ? "fleet" : "run",
      });
      if (!read.ok) return read;
      items.push(...toApprovalItems(read.value));
      if (read.value.nextCursor === null) break;
      cursor = read.value.nextCursor;
      // The last page the bound allows still carried a cursor, so the queue
      // holds approvals this read did not take.
      more = page === MAX_PENDING_PAGES - 1;
    }
    const view = ApprovalQueue.safeParse({ items, more });
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
