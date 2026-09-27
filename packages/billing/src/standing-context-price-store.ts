/**
 * standing-context-price-store.ts — the workspace's weekly price per 1,000
 * tokens of standing context, read from `cost.run_totals` (spec detector 2).
 * The pure arithmetic is in ./standing-context-price.ts.
 *
 * The requests are every model call the workspace's runs made in the last
 * 7 days. The read price is the cache reads the rollup priced over the cache
 * read tokens, on runs whose cost is not estimated, so a guess never prices
 * the week. A model with an unpriced call is left out of the price, since its
 * tokens count that call and its cost does not; a row stored before
 * `hasUnpriced` existed is unpriced when its cost is null. Free cache reads
 * price the week at zero. The tool and steering pages quote this one price, so a provider
 * and a record of the same size cost the same.
 */
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import {
  STANDING_CONTEXT_WEEK_DAYS,
  weeklyPricePerThousand,
  type WeeklyContextPrice,
} from "./standing-context-price";

const DAY_MS = 24 * 60 * 60 * 1000;

interface WeekRow {
  requests: string | number | null;
  micros: string | number | null;
  tokens: string | number | null;
  currencies: string | number | null;
  currency: string | null;
}

/** A Postgres numeric sum as a whole bigint; null reads as 0. */
function whole(value: string | number | null): bigint {
  if (value === null) return 0n;
  const text = String(value);
  const dot = text.indexOf(".");
  return BigInt(dot === -1 ? text : text.slice(0, dot));
}

/**
 * The weekly price per 1,000 tokens for one workspace; null when the week
 * made no request, no fully priced model read the cache, or the priced runs
 * name more than one currency.
 */
export async function readWeeklyContextPrice(
  scope: { orgId: string; workspaceId: string },
  now: Date = new Date(),
): Promise<WeeklyContextPrice | null> {
  const since = new Date(now.getTime() - STANDING_CONTEXT_WEEK_DAYS * DAY_MS);
  const rows = await withTenantDb(async (tx) => {
    const result = await tx.execute(sql`
      with week as (
        select t.model_calls, t.currency, t.cost_basis, t.breakdown
        from cost.run_totals t
        where t.org_id = ${scope.orgId}
          and t.workspace_id = ${scope.workspaceId}
          and t.started_at >= ${since.toISOString()}::timestamptz
          and t.started_at < ${now.toISOString()}::timestamptz
      ),
      reads as (
        select
          sum((m->'costByClass'->>'cache_read')::numeric) as micros,
          sum((m->'tokens'->>'cache_read')::numeric) as tokens,
          count(distinct w.currency) as currencies,
          min(w.currency) as currency
        from week w
        cross join lateral jsonb_array_elements(w.breakdown->'models') m
        where w.cost_basis is not null and w.cost_basis <> 'estimated'
          and (m->'tokens'->>'cache_read')::numeric > 0
          and not coalesce(
            (m->>'hasUnpriced')::boolean,
            (m->>'costMicros') is null
          )
      )
      select
        (select sum(model_calls) from week) as requests,
        reads.micros, reads.tokens, reads.currencies, reads.currency
      from reads
    `);
    return Array.from(result as Iterable<WeekRow>);
  });
  const row = rows[0];
  if (!row || row.currency === null || Number(row.currencies) !== 1)
    return null;
  const requests = Number(whole(row.requests));
  const micros = whole(row.micros);
  const tokens = whole(row.tokens);
  if (requests === 0 || tokens === 0n) return null;
  return {
    perThousandMicros: weeklyPricePerThousand({ micros, tokens }, requests),
    currency: row.currency,
    requests,
    since,
  };
}
