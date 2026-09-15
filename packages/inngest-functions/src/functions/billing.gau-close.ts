import {
  closeEndedGauPeriods,
  resumePendingGauSettlements,
  type GauJobPage,
} from "@oxagen/billing";
import type { StepContext } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/**
 * Walk one keyset-paged billing step to its end, one checkpointed step.run
 * per page, so a timeout on one page never repeats the pages before it.
 * Returns the number of rows the pages saw.
 */
async function runPaged(
  step: Pick<StepContext, "run">,
  name: string,
  page: (cursor: string | null) => Promise<GauJobPage>,
): Promise<number> {
  let processed = 0;
  let cursor: string | null = null;
  for (let n = 0; ; n++) {
    const from: string | null = cursor;
    const result: GauJobPage = await step.run(`${name}-${n}`, () => page(from));
    processed += result.processed;
    if (result.nextCursor === null) return processed;
    cursor = result.nextCursor;
  }
}

/**
 * Hourly governed-action settlement job (apps/app/ARCHITECTURE.md §3.9 item
 * 10). Hourly, so an interim invoice claimed during a Stripe outage is cut
 * and charged the same day.
 *
 *   1. closeEndedGauPeriods — every month that has ended gets `closed_at`;
 *      an invoice-billed month with uninvoiced overage is invoiced for it.
 *   2. resumePendingGauSettlements — every settlement still `pending` after
 *      an hour is carried on from Stripe's own state, superseded, or marked
 *      failed once its idempotency window has closed.
 *
 * Every write runs on withSystemDb inside @oxagen/billing, since the job has
 * no tenant scope. Both steps are idempotent: a second run finds nothing to
 * close and nothing pending, so Inngest retries are safe.
 */
export const [billingGauClose] = createFunction(
  { id: "billing.gau-close", retries: 3 },
  { cron: "10 * * * *" },
  async ({ step }) => {
    const closed = await runPaged(step, "closeEndedGauPeriods", (cursor) =>
      closeEndedGauPeriods(cursor),
    );
    const resumed = await runPaged(
      step,
      "resumePendingGauSettlements",
      (cursor) => resumePendingGauSettlements(cursor),
    );
    logger.info({ closed, resumed }, "billing.gau-close complete");
    return { closed, resumed };
  },
);
