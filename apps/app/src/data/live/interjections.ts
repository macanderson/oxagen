// The interjections port on the kernel (ARCHITECTURE.md §3.3): the open
// questions agents in a workspace, or in one run, paused to ask a person, and
// one run's questions answered or not, from list_interjections, a
// noBillingGate read (#3839, #3941).
//
// `open` walks the cursor to the end of the queue, as approvals.pending does,
// because the Fleet waiting tile and the Fleet count add up what it returns.
// It stops at a bound and says `more` there, so a count reads as a floor
// rather than as the whole queue. `forRun` reads one page: a run raises a
// repository question at most once per session, so a full page of one run's
// questions is already far past what the Run page draws.
import "server-only";
import { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  type InterjectionItem,
  InterjectionQueue,
} from "@/data/contracts/interjections";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toInterjectionItems } from "./mappers/interjections";

const PAGE_SIZE = 100;
/** How many pages `open` walks before it stops (10 * PAGE_SIZE = 1,000 questions). */
const MAX_OPEN_PAGES = 10;

/** The one place a read the view refuses is reported, for both methods. */
function unmappable(
  orgId: string,
  error: unknown,
  method: "open" | "forRun",
) {
  captureError({
    error,
    source: "app",
    orgId,
    context: `interjections.${method} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const interjections: DataSource["interjections"] = {
  async open(ctx, q) {
    const items: z.input<typeof InterjectionItem>[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < MAX_OPEN_PAGES; page += 1) {
      const read = await kernelRead(ctx, {
        contract: agentInterjectionList,
        input: {
          ...(q.runId === null ? {} : { runId: q.runId }),
          open: true,
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        page: q.runId === null ? "fleet" : "run",
      });
      if (!read.ok) return read;
      items.push(...toInterjectionItems(read.value));
      if (read.value.nextCursor === null) break;
      cursor = read.value.nextCursor;
      // The last page the bound allows still carried a cursor, so the queue
      // holds questions this read did not take.
      more = page === MAX_OPEN_PAGES - 1;
    }
    const view = InterjectionQueue.safeParse({ items, more });
    if (!view.success) return unmappable(ctx.orgId, view.error, "open");
    return readOk(view.data);
  },

  async forRun(ctx, runId) {
    const read = await kernelRead(ctx, {
      contract: agentInterjectionList,
      input: { runId, open: false, limit: PAGE_SIZE },
      page: "run",
    });
    if (!read.ok) return read;
    const view = InterjectionQueue.safeParse({
      items: toInterjectionItems(read.value),
      more: read.value.nextCursor !== null,
    });
    if (!view.success) return unmappable(ctx.orgId, view.error, "forRun");
    return readOk(view.data);
  },
};
