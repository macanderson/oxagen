// usage-analytics.ts
//
// Grouped aggregates over the ClickHouse `token_usage` table for the usage
// dashboard (billing.usage.breakdown capability). Answers "where did my spend
// go?" along several dimensions — model, surface, workspace, capability,
// principal, user — plus a daily time series, for a single org over a
// bounded time window.
//
// Design:
//   - Every query filters by `org_id` (mandatory) and, when supplied, a single
//     `workspace_id` — so a member scoped to one workspace can narrow the view.
//     The org filter is never optional: this is the tenant boundary.
//   - Aggregation happens in ClickHouse (GROUP BY), so the payload is bounded by
//     the cardinality of models/surfaces/workspaces/days, not by row volume.
//   - `totals` are derived from `byModel` in JS rather than a fifth query, so the
//     headline number can never disagree with the sum of the model table.
//   - UInt64 columns (`*_tokens`, `cost_usd_micros`) return as decimal strings on
//     the JSON wire; every numeric is coerced through Number().
//
// This mirrors sumTokenUsage (same table, same tenant param convention) but adds
// the per-dimension GROUP BY the usage-breakdown pipeline needs.

import { clickhouse } from "./clickhouse";

/** Token + cost + execution totals for a scope/window. All values are absolute counts. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache READ tokens (cache hits) — a subset of inputTokens. */
  cachedTokens: number;
  /**
   * Prompt-cache WRITE tokens (cache creation) — a subset of inputTokens billed
   * at the provider premium. Pre-migration-0026 rows carry 0.
   */
  cacheWriteTokens: number;
  /** Sum of cost_usd_micros (micro-USD; 1 USD = 1_000_000). */
  costMicros: number;
  /** Number of token_usage rows (LLM calls) in scope. */
  executions: number;
  /**
   * Distinct chat-turn (execution_step_id) count in scope — "how many messages",
   * as opposed to `executions` ("how many LLM calls"); one turn can drive
   * several model calls (tool loops, retries), so messages <= executions.
   */
  messages: number;
}

/** One point of the daily time series. `day` is a `YYYY-MM-DD` calendar date (UTC). */
export interface UsageTimePoint extends UsageTotals {
  day: string;
}

/** One grouped row of a dimension breakdown (by model / surface / workspace / …). */
export interface UsageBreakdownRow extends UsageTotals {
  /** The grouping key: model id, surface name, workspace/principal UUID, or capability name. */
  key: string;
  /** Provider slug — populated for the model breakdown only; empty string otherwise. */
  provider: string;
}

/** One grouped row of the principal breakdown (accountability chain). */
export interface UsagePrincipalRow extends UsageTotals {
  /** Acting principal uuid; the nil UUID groups unattributed legacy/system spend. */
  principalId: string;
  /** "human" | "agent" | "service", or '' for unattributed rows. */
  principalKind: string;
}

/** One grouped row of the per-user breakdown (seat-level "who used it" view). */
export interface UserUsageRow extends UsageTotals {
  /** Acting user uuid; the nil UUID groups unattributed (non-human/system) rows. */
  userId: string;
}

export interface UsageBreakdown {
  totals: UsageTotals;
  series: UsageTimePoint[];
  byModel: UsageBreakdownRow[];
  bySurface: UsageBreakdownRow[];
  byWorkspace: UsageBreakdownRow[];
  /**
   * Per-capability spend (migration 0023). Rows written before the principal
   * spine landed group under the '' key.
   */
  byCapability: UsageBreakdownRow[];
  /**
   * Per-principal spend (migration 0023) — the "who spent it" dimension that
   * makes per-seat / per-agent metering possible. Pre-spine rows group under
   * the nil UUID.
   */
  byPrincipal: UsagePrincipalRow[];
  /**
   * Per-user spend — the seat-level dimension keyed on `token_usage.user_id`
   * (populated via the ambient principal stamp, same column as byPrincipal
   * but scoped to the human account rather than the acting principal, which
   * may be an agent/service acting on the user's behalf). Rows written before
   * the principal spine landed, or driven by a non-human writer, group under
   * the nil UUID.
   */
  byUser: UserUsageRow[];
}

/** Raw JSONEachRow shape: ClickHouse serializes UInt64 sums as decimal strings. */
interface RawAgg {
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  cache_write_tokens: string;
  cost_micros: string;
  executions: string;
  messages: string;
}

const EMPTY_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 0,
  executions: 0,
  messages: 0,
};

function toTotals(r: RawAgg): UsageTotals {
  return {
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cachedTokens: Number(r.cached_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    costMicros: Number(r.cost_micros),
    executions: Number(r.executions),
    messages: Number(r.messages),
  };
}

// The aggregate projection is identical across every query; only the grouping
// key column and GROUP BY clause change. Keeping it in one place guarantees the
// breakdowns and the series compute the same measures the same way.
//
// `messages` counts distinct chat turns (execution_step_id) rather than rows:
// a single turn can drive several token_usage rows (tool loops, retries), so
// this is strictly <= executions and answers "how many turns" not "how many
// LLM calls".
//
// Caveat: the nil-UUID sentinel counts as one distinct value. Every stepless
// row in the window (ingestion embeddings, image/video generation — see
// NIL_UUID in clickhouse.ts) therefore collapses into a single phantom "turn",
// adding at most 1 per group. Immaterial at dashboard grain, and not a billed
// figure, but it is why a group with only stepless rows reports messages = 1.
const AGG_SELECT = `
  sum(input_tokens)                        AS input_tokens,
  sum(output_tokens)                       AS output_tokens,
  sum(cached_tokens)                       AS cached_tokens,
  sum(cache_write_tokens)                  AS cache_write_tokens,
  sum(cost_usd_micros)                     AS cost_micros,
  count()                                  AS executions,
  count(DISTINCT execution_step_id)        AS messages`;

/**
 * Aggregate `token_usage` for one org over `[start, end)`, grouped along model,
 * surface, workspace, and day. When `workspaceId` is supplied every group is
 * additionally narrowed to that workspace.
 *
 * `totals` is the sum of `byModel` (models are always set on every row), so the
 * headline figure and the model table are guaranteed consistent.
 *
 * The window is half-open `[start, end)` to match sumTokenUsage and avoid
 * double-counting a row at a period boundary.
 */
export async function readUsageBreakdown(args: {
  orgId: string;
  workspaceId?: string;
  start: Date;
  end: Date;
}): Promise<UsageBreakdown> {
  const ch = clickhouse();

  const wsFilter = args.workspaceId
    ? "AND workspace_id = {workspaceId:UUID}"
    : "";
  const params: Record<string, unknown> = {
    orgId: args.orgId,
    // ClickHouse's best_effort parser accepts the ISO `T` but chokes on the
    // trailing `Z` against a DateTime64 param, so strip it (matches sumTokenUsage).
    start: args.start.toISOString().replace("Z", ""),
    end: args.end.toISOString().replace("Z", ""),
  };
  if (args.workspaceId) params.workspaceId = args.workspaceId;

  const where = `
    WHERE org_id = {orgId:UUID}
      AND created_at >= {start:DateTime64(3)}
      AND created_at <  {end:DateTime64(3)}
      ${wsFilter}`;

  type GroupedRaw = RawAgg & { group_key: string; provider?: string };
  // `extraSelect` is an aggregate projection (e.g. `any(provider)`) that must NOT
  // appear in GROUP BY — the grouping is on `group_key` alone. A model maps 1:1 to
  // a provider, so `any(provider)` is exact per group.
  async function runGrouped(
    keyExpr: string,
    extraSelect = "",
  ): Promise<GroupedRaw[]> {
    const result = await ch.query({
      query: `
        SELECT ${keyExpr} AS group_key${extraSelect ? `, ${extraSelect}` : ""},
          ${AGG_SELECT}
        FROM token_usage
        ${where}
        GROUP BY group_key
        ORDER BY cost_micros DESC, executions DESC
      `,
      query_params: params,
      format: "JSONEachRow",
    });
    return (await result.json()) as GroupedRaw[];
  }

  // Daily time series — grouped on the calendar date, ordered chronologically.
  const seriesPromise = (async (): Promise<UsageTimePoint[]> => {
    const result = await ch.query({
      query: `
        SELECT toString(toDate(created_at)) AS day,
          ${AGG_SELECT}
        FROM token_usage
        ${where}
        GROUP BY day
        ORDER BY day ASC
      `,
      query_params: params,
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<RawAgg & { day: string }>;
    return rows.map((r) => ({ day: r.day, ...toTotals(r) }));
  })();

  const [
    seriesRows,
    modelRows,
    surfaceRows,
    workspaceRows,
    capabilityRows,
    principalRows,
    userRows,
  ] = await Promise.all([
    seriesPromise,
    // `any(provider)` is exact here: a given model id maps to exactly one provider.
    runGrouped("model", "any(provider) AS provider"),
    runGrouped("surface"),
    runGrouped("workspace_id"),
    runGrouped("capability_name"),
    // principal_kind rides along like provider does for models: a principal
    // uuid maps to exactly one kind, so `any()` is exact per group.
    runGrouped("toString(principal_id)", "any(principal_kind) AS provider"),
    runGrouped("toString(user_id)"),
  ]);

  const byModel: UsageBreakdownRow[] = modelRows.map((r) => ({
    key: r.group_key,
    provider: r.provider ?? "",
    ...toTotals(r),
  }));
  const bySurface: UsageBreakdownRow[] = surfaceRows.map((r) => ({
    key: r.group_key,
    provider: "",
    ...toTotals(r),
  }));
  const byWorkspace: UsageBreakdownRow[] = workspaceRows.map((r) => ({
    key: r.group_key,
    provider: "",
    ...toTotals(r),
  }));
  const byCapability: UsageBreakdownRow[] = capabilityRows.map((r) => ({
    key: r.group_key,
    provider: "",
    ...toTotals(r),
  }));
  const byPrincipal: UsagePrincipalRow[] = principalRows.map((r) => ({
    principalId: r.group_key,
    principalKind: r.provider ?? "",
    ...toTotals(r),
  }));
  const byUser: UserUsageRow[] = userRows.map((r) => ({
    userId: r.group_key,
    ...toTotals(r),
  }));

  const totals = byModel.reduce<UsageTotals>(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cachedTokens: acc.cachedTokens + r.cachedTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      costMicros: acc.costMicros + r.costMicros,
      executions: acc.executions + r.executions,
      // `messages` is a DISTINCT count, not additive: summing per-model rows
      // upper-bounds the true turn count (a turn spanning two models is counted
      // in each). Exact for the common single-model turn; a small over-count in
      // the rare cross-model case. Chat-turns is a grain-approximate dashboard
      // metric (see docs/specs/usage-analytics §02), not a billed figure.
      messages: acc.messages + r.messages,
    }),
    { ...EMPTY_TOTALS },
  );

  return {
    totals,
    series: seriesRows,
    byModel,
    bySurface,
    byWorkspace,
    byCapability,
    byPrincipal,
    byUser,
  };
}

/**
 * One DISJOINT slice of an org's usage for reseller attribution — the joint
 * (workspace, principal, capability) grouping, so the slices sum to the org's
 * total exactly once. The per-dimension breakdowns above are each a MARGINAL
 * projection of the same usage and overlap, so summing across them would
 * multi-count; attribution must run over disjoint slices instead.
 */
export interface ResellerUsageSlice {
  /** workspace_id uuid as a string. */
  workspaceId: string;
  /** acting principal_id uuid as a string (nil uuid = unattributed legacy/system). */
  principalId: string;
  /** "human" | "agent" | "service", or "" for unattributed rows. */
  principalKind: string;
  /** capability name, or "" for pre-spine rows. */
  capabilityName: string;
  /** Raw metered cost for the slice, in micro-USD. */
  costMicros: number;
  /** Metered executions (token_usage rows) in the slice — the per_unit quantity. */
  executions: number;
}

/**
 * Aggregate `token_usage` for one org over `[start, end)` grouped by the joint
 * (workspace, principal, capability) key. Each returned row is a disjoint slice
 * of total spend, so a reseller can attribute every dollar to exactly one
 * customer via priority-ordered rules with no double counting.
 *
 * Mirrors readUsageBreakdown's tenant/param conventions (mandatory org filter,
 * half-open window, `Z`-stripped DateTime64 params). `principal_kind` rides
 * along via `any()` — a principal maps 1:1 to a kind, so it is exact per group
 * and must NOT appear in GROUP BY.
 */
export async function readResellerUsageAttribution(args: {
  orgId: string;
  start: Date;
  end: Date;
}): Promise<ResellerUsageSlice[]> {
  const ch = clickhouse();
  const params: Record<string, unknown> = {
    orgId: args.orgId,
    start: args.start.toISOString().replace("Z", ""),
    end: args.end.toISOString().replace("Z", ""),
  };

  const result = await ch.query({
    query: `
      SELECT
        toString(workspace_id)  AS workspace_id,
        toString(principal_id)  AS principal_id,
        any(principal_kind)     AS principal_kind,
        capability_name         AS capability_name,
        sum(cost_usd_micros)    AS cost_micros,
        count()                 AS executions
      FROM token_usage
      WHERE org_id = {orgId:UUID}
        AND created_at >= {start:DateTime64(3)}
        AND created_at <  {end:DateTime64(3)}
      GROUP BY workspace_id, principal_id, capability_name
      ORDER BY cost_micros DESC
    `,
    query_params: params,
    format: "JSONEachRow",
  });

  const rows = (await result.json()) as Array<{
    workspace_id: string;
    principal_id: string;
    principal_kind: string;
    capability_name: string;
    cost_micros: string;
    executions: string;
  }>;

  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    principalId: r.principal_id,
    principalKind: r.principal_kind ?? "",
    capabilityName: r.capability_name ?? "",
    costMicros: Number(r.cost_micros),
    executions: Number(r.executions),
  }));
}
