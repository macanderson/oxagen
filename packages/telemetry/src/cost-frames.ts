/**
 * cost-frames.ts — the per-frame reads the spend rollup is rebuilt from
 * (Mission Control spec §12.3; ADR-060 §3).
 *
 * Two stores hold model-call frames. A gateway-metered call is one
 * `token_usage` row keyed on the run it ran for (`execution_step_id`), priced
 * by the gateway: `gateway_observed`. A wrapped agent's call is one
 * `tacho_events` row of kind `llm_call`, reported by the harness:
 * `client_attested`. Both come back in one shape with the token classes of
 * spec §12.6, so the rollup prices them the same way.
 *
 * The tacho table receives the same model call from more than one source
 * (hook, collector, OTel log, transcript); the token-bearing sources are
 * `otel_log`, `collector` and `hook`, the same rule the ingest handler folds
 * session totals by, and FINAL collapses a redelivered (session, seq). Those
 * sources carry cache writes as one `cache_creation_tokens` figure (the
 * 5m/1h split and thinking tokens are transcript columns, docs/specs/tacho/
 * data-model.md §2.7), so a wrapped run's cache writes are priced as 5m
 * writes, the same rule the ledger branch applies to `cache_write_tokens`.
 */
import { breakerEnvConfig } from "./breaker-config";
import { getBreaker } from "./circuit-breaker";
import { clickhouse } from "./clickhouse";

type CostFrameBasis = "gateway_observed" | "client_attested";

export interface ModelCallFrameRow {
  /** RFC 3339. */
  at: string;
  model: string;
  provider: string | null;
  inputUncached: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  /** The micro-USD the frame's own record carries; null when it carries none. */
  reportedCostMicros: string | null;
  basis: CostFrameBasis;
}

interface ToolCallFrameRow {
  /** Null when the frame names no tool. */
  name: string | null;
}

/** The run a frame read is keyed on: the ledger run uuid or the tacho root session uuid. */
export type FrameRunRef =
  | { kind: "ledger"; runUuid: string }
  | { kind: "tacho"; rootSessionUuid: string };

const breaker = () => getBreaker("clickhouse", breakerEnvConfig());

const TACHO_TOKEN_SOURCES = ["otel_log", "collector", "hook"];

/**
 * Every model-call frame of one run, oldest first. Throws on a degraded
 * store: the rollup job retries rather than writing a row from missing frames.
 */
export async function readModelCallFrames(args: {
  orgId: string;
  run: FrameRunRef;
}): Promise<ModelCallFrameRow[]> {
  const ch = clickhouse();
  const run = args.run;
  if (run.kind === "ledger") {
    const result = await breaker().exec(() =>
      ch.query({
        query: `
        SELECT
          formatDateTime(created_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS at,
          model,
          provider,
          toInt64(greatest(0, toInt64(input_tokens) - toInt64(cached_tokens) - toInt64(cache_write_tokens))) AS input_uncached,
          cached_tokens        AS cache_read,
          cache_write_tokens   AS cache_write_5m,
          output_tokens        AS output,
          cost_usd_micros      AS cost_micros
        FROM token_usage
        WHERE org_id = {orgId:UUID}
          AND execution_step_id = {runId:UUID}
        ORDER BY created_at
      `,
        query_params: { orgId: args.orgId, runId: run.runUuid },
        format: "JSONEachRow",
      }),
    );
    type Row = {
      at: string;
      model: string;
      provider: string;
      input_uncached: string;
      cache_read: string;
      cache_write_5m: string;
      output: string;
      cost_micros: string;
    };
    const rows = (await result.json()) as Row[];
    return rows.map((r) => ({
      at: r.at,
      model: r.model,
      provider: r.provider === "" ? null : r.provider,
      inputUncached: Number(r.input_uncached),
      cacheRead: Number(r.cache_read),
      cacheWrite5m: Number(r.cache_write_5m),
      cacheWrite1h: 0,
      output: Number(r.output),
      reasoning: 0,
      reportedCostMicros: r.cost_micros,
      basis: "gateway_observed",
    }));
  }

  const result = await breaker().exec(() =>
    ch.query({
      query: `
      SELECT
        formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS at,
        model,
        provider,
        coalesce(input_tokens, 0)          AS input_uncached,
        coalesce(cache_read_tokens, 0)     AS cache_read,
        coalesce(cache_creation_tokens, 0) AS cache_write_5m,
        coalesce(output_tokens, 0)         AS output,
        cost_usd_micros                    AS cost_micros
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID}
        AND root_session_uuid = {rootSessionUuid:UUID}
        AND kind = 'llm_call'
        AND source IN {sources:Array(String)}
        AND model != ''
      ORDER BY ts, seq
    `,
      query_params: {
        orgId: args.orgId,
        rootSessionUuid: run.rootSessionUuid,
        sources: TACHO_TOKEN_SOURCES,
      },
      format: "JSONEachRow",
    }),
  );
  type Row = {
    at: string;
    model: string;
    provider: string;
    input_uncached: string;
    cache_read: string;
    cache_write_5m: string;
    output: string;
    cost_micros: string | null;
  };
  const rows = (await result.json()) as Row[];
  return rows.map((r) => ({
    at: r.at,
    model: r.model,
    provider: r.provider === "" ? null : r.provider,
    inputUncached: Number(r.input_uncached),
    cacheRead: Number(r.cache_read),
    cacheWrite5m: Number(r.cache_write_5m),
    cacheWrite1h: 0,
    output: Number(r.output),
    reasoning: 0,
    reportedCostMicros: r.cost_micros,
    basis: "client_attested",
  }));
}

/**
 * Every tool-call frame of one wrapped run. The hook source is the one that
 * carries a tool call once (the ingest handler's `numToolCalls` rule); a
 * ledger run's tool calls are its `tool.call_completed` events in Postgres,
 * which the rollup store reads.
 */
export async function readTachoToolCallFrames(args: {
  orgId: string;
  rootSessionUuid: string;
}): Promise<ToolCallFrameRow[]> {
  const ch = clickhouse();
  const result = await breaker().exec(() =>
    ch.query({
      query: `
      SELECT tool_name AS name
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID}
        AND root_session_uuid = {rootSessionUuid:UUID}
        AND kind = 'tool_call'
        AND source = 'hook'
      ORDER BY ts, seq
    `,
      query_params: {
        orgId: args.orgId,
        rootSessionUuid: args.rootSessionUuid,
      },
      format: "JSONEachRow",
    }),
  );
  const rows = (await result.json()) as { name: string }[];
  return rows.map((r) => ({ name: r.name === "" ? null : r.name }));
}
