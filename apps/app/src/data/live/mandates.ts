// The mandates port on the kernel (ARCHITECTURE.md §3.3): the workspace's
// mandates with the remaining authority the ledger records, or the mandates
// one agent holds. `list_mandates` is a noBillingGate read the accountable
// org roles hold; a member without one is denied on it, which every caller
// renders as the section's own refusal rather than as a page error.
//
// The contract takes no cursor, so the read asks for its largest page and the
// view model says when the answer filled it. A ledger that stopped at its
// bound without saying so would hide mandates from the office accountable for
// them, and would blank the bar on an approval card drawing on one of them.
// Paging this read wants a cursor on `list_mandates`.
import "server-only";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { captureError } from "@oxagen/telemetry";
import { MandateList } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toMandateList } from "./mappers/mandates";

/** `list_mandates`' largest page (`mandate.list.ts`: limit max 100). */
const PAGE_SIZE = 100;

export const mandates: DataSource["mandates"] = {
  async list(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: mandateList,
      input:
        q.agentId === null
          ? { limit: PAGE_SIZE }
          : { agentId: q.agentId, limit: PAGE_SIZE },
      page: "mandates",
    });
    if (!read.ok) return read;
    const view = MandateList.safeParse(
      toMandateList(read.value, PAGE_SIZE),
    );
    if (!view.success) {
      captureError({
        error: view.error,
        source: "app",
        orgId: ctx.orgId,
        context: "mandates.list record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return readOk(view.data);
  },
};
