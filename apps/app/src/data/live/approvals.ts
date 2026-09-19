// The approvals port on the kernel (ARCHITECTURE.md §3.3): the pending
// approvals of the workspace, or of one run, from list_approvals, a
// noBillingGate read. One page of the contract's largest size: the Fleet tile
// counts what this returns.
import "server-only";
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { captureError } from "@oxagen/telemetry";
import { z } from "zod";
import { ApprovalItem, ResolvedApprovalItem } from "@/data/contracts/approvals";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toApprovalItems, toResolvedApprovalItems } from "./mappers/approvals";

const PAGE_SIZE = 100;

export const approvals: DataSource["approvals"] = {
  async pending(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: agentApprovalList,
      input:
        q.runId === null
          ? { limit: PAGE_SIZE }
          : { runId: q.runId, limit: PAGE_SIZE },
      page: q.runId === null ? "fleet" : "run",
    });
    if (!read.ok) return read;
    const view = z.array(ApprovalItem).safeParse(toApprovalItems(read.value));
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
  async resolved(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: agentApprovalListResolved,
      input: { runId: q.runId, limit: PAGE_SIZE },
      page: "run",
    });
    if (!read.ok) return read;
    const view = z
      .array(ResolvedApprovalItem)
      .safeParse(toResolvedApprovalItems(read.value));
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
