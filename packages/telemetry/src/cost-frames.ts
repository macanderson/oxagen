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
 * `LLM_CALL_TOKEN_SOURCES`, the same rule the ingest handler folds session
 * totals by, and FINAL collapses a redelivered (session, seq). FINAL does NOT
 * collapse two sources' records of one call: each carries its own `seq`. The
 * host correlates them instead, per call, as it seals them — on the vendor
 * `request_id`, then the message id, then the token tuple — and stamps every
 * sighting after the first with `oxagen.llm_call_duplicate_of`, so the reads
 * below drop a stamped row and price each call once ({@link
 * TACHO_TOKEN_SOURCES}). Those sources carry cache writes as one
 * `cache_creation_tokens` figure (the 5m/1h split and thinking tokens are
 * transcript columns, docs/specs/tacho/data-model.md §2.7), so a wrapped
 * run's cache writes are priced as 5m writes, the same rule the ledger
 * branch applies to `cache_write_tokens`.
 *
 * The findings job reads a workspace's tool calls with their digests and
 * result tokens through the same client (`readTachoToolCallObservations`).
 */
import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LLM_CALL_TOKEN_SOURCES,
} from "@oxagen/tacho";
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

/**
 * The rollup prices each model call once, by the rule the ingest fold uses
 * (`countsLlmCallUsage` in @oxagen/tacho): a token-bearing source, transcript
 * included, and no duplicate stamp. The host stamps a later sighting of a call
 * it already sealed from another source, and a transcript continuation block,
 * with `oxagen.llm_call_duplicate_of`.
 */
const TACHO_TOKEN_SOURCES: readonly string[] = LLM_CALL_TOKEN_SOURCES;

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
        AND attrs[{duplicateAttr:String}] = ''
        AND model != ''
      ORDER BY ts, seq
    `,
      query_params: {
        orgId: args.orgId,
        rootSessionUuid: run.rootSessionUuid,
        sources: TACHO_TOKEN_SOURCES,
        duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
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

/** One hook-recorded tool call of a wrapped run, as the findings job reads it. */
export interface ToolCallObservationRow {
  rootSessionUuid: string;
  /** RFC 3339. */
  at: string;
  seq: number;
  tool: string;
  inputDigest: string;
  /** Empty when the hook recorded no output. */
  outputDigest: string;
  isMutating: boolean | null;
  /** The result tokens the OTel tool span recorded for the same tool use; null when none did. */
  resultTokens: number | null;
}

/** ClickHouse DateTime64 params want a space-separated, Z-less string. */
function chDateTime(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * A workspace's tool calls over [from, to), newest first, at most `limit`
 * (Mission Control spec §12.8; ADR-062). The hook source carries a call once
 * with its input and output digests and the classifier's mutating flag; the
 * OTel tool span of the same tool use carries its result tokens, joined on
 * `tool_use_id`. Throws on a degraded store: the findings job retries rather
 * than detecting over missing frames.
 */
export async function readTachoToolCallObservations(args: {
  orgId: string;
  workspaceId: string;
  from: Date;
  to: Date;
  limit: number;
}): Promise<ToolCallObservationRow[]> {
  const ch = clickhouse();
  const result = await breaker().exec(() =>
    ch.query({
      query: `
      SELECT
        toString(h.root_session_uuid)                                  AS root_session_uuid,
        formatDateTime(h.ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')           AS at,
        h.seq                                                          AS seq,
        h.tool_name                                                    AS tool,
        h.tool_input_digest                                            AS input_digest,
        h.tool_output_digest                                           AS output_digest,
        h.tool_is_mutating                                             AS is_mutating,
        r.result_tokens                                                AS result_tokens
      FROM (
        SELECT root_session_uuid, ts, seq, tool_name, tool_input_digest,
               tool_output_digest, tool_is_mutating, tool_use_id
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND kind = 'tool_call'
          AND source = 'hook'
          AND ts >= {from:DateTime64(3)}
          AND ts < {to:DateTime64(3)}
          AND tool_name != ''
          AND tool_input_digest != ''
        ORDER BY ts DESC, seq DESC
        LIMIT {limit:UInt32}
      ) AS h
      LEFT JOIN (
        SELECT tool_use_id, max(tool_result_tokens) AS result_tokens
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND kind = 'tool_call'
          AND source = 'otel_span'
          AND ts >= {from:DateTime64(3)}
          AND ts < {to:DateTime64(3)}
          AND tool_use_id != ''
          AND tool_result_tokens IS NOT NULL
        GROUP BY tool_use_id
      ) AS r ON r.tool_use_id = h.tool_use_id
      SETTINGS join_use_nulls = 1
    `,
      query_params: {
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        from: chDateTime(args.from),
        to: chDateTime(args.to),
        limit: args.limit,
      },
      format: "JSONEachRow",
    }),
  );
  type Row = {
    root_session_uuid: string;
    at: string;
    seq: string | number;
    tool: string;
    input_digest: string;
    output_digest: string;
    is_mutating: boolean | null;
    result_tokens: string | number | null;
  };
  const rows = (await result.json()) as Row[];
  return rows.map((r) => ({
    rootSessionUuid: r.root_session_uuid,
    at: r.at,
    seq: Number(r.seq),
    tool: r.tool,
    inputDigest: r.input_digest,
    outputDigest: r.output_digest,
    isMutating: r.is_mutating,
    resultTokens: r.result_tokens === null ? null : Number(r.result_tokens),
  }));
}

/** One model an organization has actually run, folded across both frame stores. */
export interface ObservedModelRow {
  model: string;
  /** Null when the frames name no vendor. */
  provider: string | null;
  /** Model calls seen in the window. */
  calls: number;
  /** Total tokens across every class, for ranking by how much the model matters. */
  tokens: number;
  /** RFC 3339. */
  firstSeen: string;
  /** RFC 3339. */
  lastSeen: string;
}

/**
 * At most this many models. An organization running more distinct model ids
 * than this has a naming problem, not a pricing one, and an unbounded list
 * would be neither readable nor cheap.
 */
const OBSERVED_MODEL_LIMIT = 500;

/**
 * The distinct models an organization has run since `since`, heaviest first
 * (Mission Control spec §12.2; ADR-060 §1). Both frame stores are read and
 * folded by model id: a model reached through the gateway and the same model
 * reached by a wrapped agent are one row, because they need one price.
 *
 * Token totals are the sum over the classes the book prices, so the two
 * stores add up the same way. `token_usage.input_tokens` is the inclusive
 * input total (fresh + cache reads + cache writes, see schema.sql), so its
 * classes are split the way {@link readModelCallFrames} splits them; the
 * tacho sources carry each class separately and are simply added. The
 * tacho branch drops a duplicate-stamped row by the same rule
 * {@link readModelCallFrames} uses, so a call two sources reported is one
 * call here too — otherwise it would rank its model above ones that need
 * pricing more.
 *
 * Throws on a degraded store: a short list read off half the frames would
 * say a model is priced when nobody has priced it.
 */
export async function readObservedModels(args: {
  orgId: string;
  workspaceId?: string;
  since: Date;
  /** Frames at or before this instant only; open-ended when omitted. */
  until?: Date;
}): Promise<ObservedModelRow[]> {
  const ch = clickhouse();
  const workspace =
    args.workspaceId === undefined
      ? ""
      : "AND workspace_id = {workspaceId:UUID}";
  const until =
    args.until === undefined ? "" : "AND {col} <= {until:DateTime64(3)}";
  const result = await breaker().exec(() =>
    ch.query({
      query: `
      SELECT
        model,
        anyIf(provider, provider != '')                                  AS provider,
        sum(calls)                                                       AS calls,
        sum(tokens)                                                      AS tokens,
        formatDateTime(min(first_seen), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')  AS first_seen,
        formatDateTime(max(last_seen), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')   AS last_seen
      FROM (
        SELECT
          toString(model)                     AS model,
          toString(provider)                  AS provider,
          count()                             AS calls,
          sum(
            greatest(0, toInt64(input_tokens) - toInt64(cached_tokens) - toInt64(cache_write_tokens))
            + toInt64(cached_tokens) + toInt64(cache_write_tokens) + toInt64(output_tokens)
          )                                   AS tokens,
          min(toDateTime64(created_at, 3, 'UTC')) AS first_seen,
          max(toDateTime64(created_at, 3, 'UTC')) AS last_seen
        FROM token_usage
        WHERE org_id = {orgId:UUID}
          AND created_at >= {since:DateTime64(3)}
          ${until.replace("{col}", "created_at")}
          AND model != ''
          ${workspace}
        GROUP BY toString(model), toString(provider)

        UNION ALL

        SELECT
          toString(model)                     AS model,
          toString(provider)                  AS provider,
          count()                             AS calls,
          sum(
            toInt64(coalesce(input_tokens, 0)) + toInt64(coalesce(cache_read_tokens, 0))
            + toInt64(coalesce(cache_creation_tokens, 0)) + toInt64(coalesce(output_tokens, 0))
          )                                   AS tokens,
          min(toDateTime64(ts, 3, 'UTC'))     AS first_seen,
          max(toDateTime64(ts, 3, 'UTC'))     AS last_seen
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND ts >= {since:DateTime64(3)}
          ${until.replace("{col}", "ts")}
          AND kind = 'llm_call'
          AND source IN {sources:Array(String)}
          AND attrs[{duplicateAttr:String}] = ''
          AND model != ''
          ${workspace}
        GROUP BY toString(model), toString(provider)
      )
      GROUP BY model
      ORDER BY tokens DESC, model
      LIMIT {limit:UInt32}
    `,
      query_params: {
        orgId: args.orgId,
        ...(args.workspaceId === undefined
          ? {}
          : { workspaceId: args.workspaceId }),
        since: chDateTime(args.since),
        ...(args.until === undefined ? {} : { until: chDateTime(args.until) }),
        sources: TACHO_TOKEN_SOURCES,
        duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
        limit: OBSERVED_MODEL_LIMIT,
      },
      format: "JSONEachRow",
    }),
  );
  type Row = {
    model: string;
    provider: string;
    calls: string | number;
    tokens: string | number;
    first_seen: string;
    last_seen: string;
  };
  const rows = (await result.json()) as Row[];
  return rows.map((r) => ({
    model: r.model,
    provider: r.provider === "" ? null : r.provider,
    calls: Number(r.calls),
    tokens: Number(r.tokens),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}
