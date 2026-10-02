// audit-exempt: read-only — lists the workspace's published steering records; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// list_records (ADR-061): the published registry. Every row now carries a
// real kind and force — a Context PR merge writes them, and since #3302
// publish_context_record requires them too, so no row can steer nothing
// without saying so.
//
// Each record also carries what its line costs (#4572): its tokens in the
// signed bundle, and those tokens at the workspace's weekly price per 1,000.
// The server multiplies, so the app prints a figure and multiplies nothing
// (ADR-060). The price is the one list_mcp_servers quotes, so a record and a
// tool provider of the same size cost the same.
import { recordCandidate } from "@oxagen/agent/runtime/published-steering";
import {
  readWeeklyContextPrice,
  weeklyCostOf,
  type WeeklyContextPrice,
} from "@oxagen/billing";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import type { PublishedRecordView } from "@oxagen/oxagen/contracts/context.steering.shared";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { publishedRecordView } from "./context.steering.view";
import { logger } from "./logger";

/** The workspace's weekly price per 1,000 tokens; null when the week has none. */
type WeeklyPriceRead = (scope: {
  orgId: string;
  workspaceId: string;
}) => Promise<WeeklyContextPrice | null>;

/**
 * The tokens of the line the signed bundle carries for a record: the line
 * `recordCandidate` builds, `- <statement> (<kind>; <lineage>)`, counted in
 * the steering assembler's unit, `ceil(utf8_bytes / 4)` (`budgetTokens` in
 * @contextgraphprotocol/typescript-sdk). Null for a record with no force or
 * no statement, which the assembler drops before counting.
 */
export function recordLineTokens(record: PublishedRecordView): number | null {
  const candidate = recordCandidate({
    slug: record.lineageId,
    kind: record.kind,
    force: record.force,
    constraintEffect: record.constraintEffect,
    statement: record.statement,
    activatedAt: null,
  });
  if (candidate === null) return null;
  return Math.ceil(new TextEncoder().encode(`- ${candidate.body}`).length / 4);
}

/**
 * The weekly price, or null when the read fails. The list goes without a
 * price rather than failing, and the log says why.
 */
async function priceOrNull(
  read: WeeklyPriceRead,
  scope: { orgId: string; workspaceId: string },
): Promise<WeeklyContextPrice | null> {
  try {
    return await read(scope);
  } catch (err: unknown) {
    logger.warn({ err }, "list_records: weekly context price read failed");
    return null;
  }
}

/**
 * The handler. `weeklyPrice` reads the workspace's weekly price per 1,000
 * tokens; without it every record's price is null, which is what a test
 * that does not price wants.
 */
export function createListRecordsHandler(
  deps: Pick<SteeringDeps, "store"> & { weeklyPrice?: WeeklyPriceRead },
): CapabilityHandler<typeof contextRecordsList> {
  return async (input, ctx) => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const [{ rows, total }, price] = await Promise.all([
      deps.store.listRecords(
        scope,
        {
          kind: input.kind,
          sharingScope: input.sharingScope,
          status: input.status,
          lineageId: input.lineageId,
        },
        { limit: input.limit, offset: input.offset },
      ),
      deps.weeklyPrice === undefined
        ? Promise.resolve(null)
        : priceOrNull(deps.weeklyPrice, scope),
    ]);
    return {
      records: rows.map((row) => {
        const view = publishedRecordView(row);
        const contextTokens = recordLineTokens(view);
        return {
          ...view,
          contextTokens,
          weeklyPrice: weeklyCostOf(contextTokens, price),
        };
      }),
      total,
    };
  };
}

export const listRecordsHandler = createListRecordsHandler({
  ...steeringDeps(),
  weeklyPrice: (scope) => readWeeklyContextPrice(scope),
});
