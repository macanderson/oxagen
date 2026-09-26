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
 * session totals by, and FINAL collapses a redelivered (session, seq). FINAL
 * does NOT collapse two sources' records of one call, so the host stamps the
 * later sighting of a call it already sealed from another source with
 * `oxagen.llm_call_duplicate_of`, and every reader below drops a stamped row
 * ({@link NOT_A_DUPLICATE}). That is the same rule `countsLlmCallUsage` in
 * @oxagen/tacho folds session totals by, so the rollup and the fold cannot
 * price a call a different number of times. Those sources carry cache writes
 * as one `cache_creation_tokens` figure; the 5m/1h split is a transcript
 * column (docs/specs/tacho/data-model.md §2.7). The book prices the two TTLs
 * at different rates, so the wrap below recovers the one-hour portion the
 * same way it recovers thinking: from the transcript row, joined back when
 * the duplicate filter dropped it. The remainder of `cache_creation_tokens`
 * is the five-minute write, matching `priceObservedUsage` in @oxagen/tacho.
 * A gateway frame has no 1h column, so its `cacheWrite1h` stays zero.
 *
 * Reasoning is another class a wrapped call reports that the gateway does
 * not. Both vendors count thinking INSIDE the output figure they publish.
 * Anthropic states it as `usage.output_tokens_details.thinking_tokens` and
 * OpenAI as `output_tokens_details.reasoning_tokens`, and the tacho
 * transcript and collector sources record either one under `thinking_tokens`.
 * So the read below subtracts it from `output_tokens` and carries it as the
 * frame's `reasoning` class, the way the ledger branch subtracts cache reads
 * and writes from an inclusive `input_tokens`. Left in `output`, every
 * thinking token is priced at the output rate, which is wrong for any model
 * whose published reasoning rate differs from its output rate. `token_usage`
 * has no thinking column at all, so a gateway frame's `reasoning` stays zero.
 *
 * The split and the duplicate filter pull against each other, so the wrapped
 * read joins them back together. When the host sealed a call's OTel or proxy
 * sighting first, the stamp lands on the transcript row, the filter above
 * drops it, and the row left to price carries neither `thinking_tokens` nor
 * `cache_creation_1h_tokens`, because the transcript is the only source that
 * records those columns. The read therefore joins that dropped transcript
 * row back on the vendor request id or the message id
 * ({@link TRANSCRIPT_THINKING}, {@link TRANSCRIPT_CACHE_1H}) and takes both
 * figures, the same rule `countsLlmCallSplit` in @oxagen/tacho states.
 * Nothing is added by the join: the call is still priced from one row, and
 * the figures only move tokens between classes that row already counted.
 *
 * The findings job reads a workspace's tool calls with their digests and
 * result tokens through the same client (`readTachoToolCallObservations`).
 */
import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LLM_CALL_TOKEN_SOURCES,
} from "@oxagen/tacho";
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
  /**
   * Provider-side web searches the call made (`web_search_requests`), which
   * the book prices per request as `server_tool_request`. Web fetches are
   * left out: the vendor does not charge per fetch, so counting them would
   * price requests nobody billed. A ledger frame has no such column, so it
   * is 0 there.
   */
  serverToolRequests: number;
  /** The micro-USD the frame's own record carries; null when it carries none. */
  reportedCostMicros: string | null;
  basis: CostFrameBasis;
}

interface ToolCallFrameRow {
  /** Null when the frame names no tool. */
  name: string | null;
}

/**
 * The run a frame read is keyed on: the ledger run uuid, or the tacho root
 * session uuid with the session of every chain in the run.
 *
 * A ledger run may also name the message that asked for it
 * (`agent_runs.origin_message_id`). The in-app assistant meters every call of
 * a turn on the person's message id, because the message exists before the
 * run is admitted and the turn's recall, approvals and credit debits all name
 * it. Its `token_usage` rows carry that id rather than the run's, so the read
 * matches either (#4167).
 *
 * A wrapped run's `sessionUuids` lists the root session first and then each
 * subagent chain under it, as `tacho.sessions` records them. `tacho_events`
 * is ordered by `(org_id, workspace_id, session_uuid, seq)` and has no index
 * on `root_session_uuid`, so a read that names the root alone scans every
 * chain in the workspace. The list lets it read only this run's chains
 * (#4103). It is required, so no caller can read a run unscoped.
 */
export type FrameRunRef =
  | { kind: "ledger"; runUuid: string; originMessageId?: string | null }
  | {
      kind: "tacho";
      rootSessionUuid: string;
      sessionUuids: readonly string[];
    };

/**
 * The rollup prices each model call once, by the rule the ingest fold uses
 * (`countsLlmCallUsage` in @oxagen/tacho): a token-bearing source, transcript
 * included, and no duplicate stamp. The host stamps a later sighting of a call
 * it already sealed from another source, and a transcript continuation block,
 * with `oxagen.llm_call_duplicate_of`.
 */
const TACHO_TOKEN_SOURCES: readonly string[] = LLM_CALL_TOKEN_SOURCES;

/**
 * The predicate that keeps one row per model call: the host has already
 * decided which sighting is the duplicate, so a reader only has to drop the
 * stamped one. Spelled once so the two reads below cannot filter differently.
 */
const NOT_A_DUPLICATE = "attrs[{duplicateAttr:String}] = ''";

/**
 * A lower bound on `received_at` for a read of `tacho_events` whose `ts`
 * window opens at the named parameter. The table partitions by the month of
 * `received_at` (#4297), so a `ts` filter alone reads every month the
 * organization holds, with FINAL, on the node every organization shares. A
 * frame stamped at or after the window's start reached the control plane no
 * earlier than that start less the host clock's lead, and the bound allows a
 * lead of one day. There is no upper bound, because a host ships buffered
 * frames late. `selectAgentDaySpend` bounds its day the same way.
 */
const receivedFrom = (param: "since" | "from") =>
  `received_at >= {${param}:DateTime64(3)} - INTERVAL 1 DAY`;
const TACHO_RECEIVED_SINCE = receivedFrom("since");

/**
 * A transcript row's thinking figure, joined back once per id the host's
 * ledger matches two sightings on: `t` on the vendor request id, `m` on the
 * message id (`llmCallKeys` in @oxagen/tacho). They are separate joins, not
 * one key that prefers the request id, because the ledger matches on EITHER
 * id: a proxy row that carries only the message id is stamped against a
 * transcript row that carries both, and a single preferred key would give
 * those two rows different keys and drop the figure. When both joins match
 * they found the same call, so `greatest` picks the one figure there is.
 *
 * The ledger's last-resort token tuple is left out on purpose. Two calls in
 * one session can share a tuple (a title prompt asked twice), and the ledger
 * only falls back to it because it sees sightings in order, which a reader
 * of the stored rows does not. A row carrying neither id joins nothing and
 * keeps its own columns.
 */
const TRANSCRIPT_THINKING =
  "greatest(coalesce(t.thinking, 0), coalesce(m.thinking, 0))";

/**
 * The one-hour cache-write figure from the same transcript joins that carry
 * thinking. `cache_creation_tokens` on the priced row is the total write;
 * this is the portion of that total that was a one-hour TTL.
 */
const TRANSCRIPT_CACHE_1H =
  "greatest(coalesce(t.cache_1h, 0), coalesce(m.cache_1h, 0))";

/**
 * The rows that carry a call's thinking and cache-TTL split, which is
 * `countsLlmCallSplit` in @oxagen/tacho spelled for the store: a transcript
 * row counts whether it was the first sighting of its call or the duplicate
 * of an OTel or proxy row, and a transcript continuation block, stamped a
 * duplicate of `transcript`, had its usage removed and carries nothing. This
 * is the one read that must NOT apply {@link NOT_A_DUPLICATE}, because the
 * row it wants is usually the stamped one.
 */
const TRANSCRIPT_SPLIT_ROW = `source = 'transcript'
          AND attrs[{duplicateAttr:String}] != 'transcript'`;

/**
 * The thinking figure a wrapped frame is priced with, and which row supplies
 * it. `c` is the row the call is priced from, the sighting the host left
 * unstamped; `t` and `m` are the same call's transcript row, joined back
 * after the duplicate filter dropped it. The transcript wins because it is the only
 * source that records the split. A call that no transcript row joins keeps
 * its own figure, which is how a collector-only call still reports its
 * reasoning.
 */
const FRAME_REASONING = `toInt64(if(${TRANSCRIPT_THINKING} > 0, ${TRANSCRIPT_THINKING}, coalesce(c.thinking_tokens, 0)))`;

/**
 * The one-hour write figure, joined the same way as thinking. Capped at the
 * priced row's total `cache_creation_tokens` so a transcript that over-reports
 * cannot invent writes the call did not make; the five-minute class is the
 * remainder (`priceObservedUsage` in @oxagen/tacho).
 */
const FRAME_CACHE_WRITE = "toInt64(coalesce(c.cache_creation_tokens, 0))";
const FRAME_CACHE_1H = `toInt64(least(${FRAME_CACHE_WRITE}, if(${TRANSCRIPT_CACHE_1H} > 0, ${TRANSCRIPT_CACHE_1H}, coalesce(c.cache_creation_1h_tokens, 0))))`;
const FRAME_CACHE_5M = `toInt64(greatest(0, ${FRAME_CACHE_WRITE} - ${FRAME_CACHE_1H}))`;

/**
 * The provider-side requests one wrapped model call is priced for, as the
 * book's `server_tool_request` class: its web searches. Anthropic bills a
 * server-side web search at $10 per 1,000 requests. It does not bill a
 * server-side web fetch per request (its usage report carries
 * `web_fetch_requests` as information only), so `web_fetch_requests` is left
 * out. Adding it priced requests nobody billed, and made a model whose calls
 * only fetched look unpriced in `list_unpriced_models` (#3281, #3721).
 *
 * No transcript join: the column sits on the priced row itself, and the
 * duplicate stamp has already left exactly one row per call. The frame read
 * and the class-bucket read both use this, so they cannot count differently.
 */
function classBucketServerToolRequests(rowAlias: string): string {
  return `toInt64(coalesce(${rowAlias}.web_search_requests, 0))`;
}
const FRAME_SERVER_TOOL_REQUESTS = classBucketServerToolRequests("c");

/**
 * The predicate that limits a wrapped run's read to its own chains, by the
 * table's sort key ({@link FrameRunRef}).
 */
const RUN_SESSIONS = "session_uuid IN {sessionUuids:Array(UUID)}";

/**
 * The sessions a wrapped run's reads name: the list the caller loaded, with
 * the root always in it, so a run whose list came back without its own
 * session still reads the root chain.
 */
function runSessions(run: {
  rootSessionUuid: string;
  sessionUuids: readonly string[];
}): string[] {
  return run.sessionUuids.includes(run.rootSessionUuid)
    ? [...run.sessionUuids]
    : [run.rootSessionUuid, ...run.sessionUuids];
}

/**
 * Every model-call frame of one run, oldest first. Throws on a degraded
 * store: the rollup job retries rather than writing a row from missing frames.
 *
 * A wrapped run's frames are read in the run's own workspace. The producer
 * names `root_session_uuid`, so a host in another workspace of the same
 * organization can stamp its frames with this run's root; without the
 * workspace predicate they were priced into this run.
 *
 * Each of the three reads also names the run's sessions
 * ({@link FrameRunRef}), so it reads the run's own chains through the table's
 * sort key instead of every chain the workspace holds (#4103). The root and
 * workspace predicates stay: a session list does not stop a host in another
 * workspace from naming one of these sessions.
 *
 * The transcript joins key on the session as well as the call id, as
 * {@link readObservedModels} does. A parent and its subagent can reuse a
 * request or message id, and a join on the id alone took `max()` over both
 * sessions and credited one call's thinking and one-hour cache split to both.
 *
 * A wrapped frame carries the call's web searches as `server_tool_request`,
 * priced per request. Web fetches are not counted: the vendor does not charge
 * per fetch (#3721).
 */
export async function readModelCallFrames(args: {
  orgId: string;
  workspaceId: string;
  run: FrameRunRef;
}): Promise<ModelCallFrameRow[]> {
  const ch = clickhouse();
  const run = args.run;
  if (run.kind === "ledger") {
    const origin = run.originMessageId ?? null;
    const result = await ch.query({
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
        FROM metered_token_usage
        WHERE org_id = {orgId:UUID}
          AND ${
            origin === null
              ? "execution_step_id = {runId:UUID}"
              : "execution_step_id IN ({runId:UUID}, {originMessageId:UUID})"
          }
        ORDER BY created_at
      `,
      query_params:
        origin === null
          ? { orgId: args.orgId, runId: run.runUuid }
          : { orgId: args.orgId, runId: run.runUuid, originMessageId: origin },
      format: "JSONEachRow",
    });
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
      serverToolRequests: 0,
      reportedCostMicros: r.cost_micros,
      basis: "gateway_observed",
    }));
  }

  const result = await ch.query({
    query: `
      SELECT
        formatDateTime(c.ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS at,
        c.model    AS model,
        c.provider AS provider,
        coalesce(c.input_tokens, 0)          AS input_uncached,
        coalesce(c.cache_read_tokens, 0)     AS cache_read,
        ${FRAME_CACHE_5M} AS cache_write_5m,
        ${FRAME_CACHE_1H} AS cache_write_1h,
        toInt64(greatest(0, toInt64(coalesce(c.output_tokens, 0)) - ${FRAME_REASONING})) AS output,
        ${FRAME_REASONING} AS reasoning,
        ${FRAME_SERVER_TOOL_REQUESTS} AS server_tool_request,
        c.cost_usd_micros AS cost_micros
      FROM (
        SELECT
          ts, seq, model, provider, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens,
          thinking_tokens, web_search_requests, cost_usd_micros, request_id,
          message_id, session_uuid
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND root_session_uuid = {rootSessionUuid:UUID}
          AND ${RUN_SESSIONS}
          AND kind = 'llm_call'
          AND source IN {sources:Array(String)}
          AND ${NOT_A_DUPLICATE}
          AND model != ''
      ) AS c
      LEFT JOIN (
        SELECT
          request_id AS call_key,
          session_uuid AS session_uuid,
          toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
          toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND root_session_uuid = {rootSessionUuid:UUID}
          AND ${RUN_SESSIONS}
          AND kind = 'llm_call'
          AND ${TRANSCRIPT_SPLIT_ROW}
        GROUP BY call_key, session_uuid
        HAVING call_key != ''
      ) AS t ON t.call_key = c.request_id AND t.session_uuid = c.session_uuid
      LEFT JOIN (
        SELECT
          message_id AS call_key,
          session_uuid AS session_uuid,
          toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
          toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND root_session_uuid = {rootSessionUuid:UUID}
          AND ${RUN_SESSIONS}
          AND kind = 'llm_call'
          AND ${TRANSCRIPT_SPLIT_ROW}
        GROUP BY call_key, session_uuid
        HAVING call_key != ''
      ) AS m ON m.call_key = c.message_id AND m.session_uuid = c.session_uuid
      ORDER BY c.ts, c.seq
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: run.rootSessionUuid,
      sessionUuids: runSessions(run),
      sources: TACHO_TOKEN_SOURCES,
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
    },
    format: "JSONEachRow",
  });
  type Row = {
    at: string;
    model: string;
    provider: string;
    input_uncached: string;
    cache_read: string;
    cache_write_5m: string;
    cache_write_1h: string;
    output: string;
    reasoning: string;
    server_tool_request: string;
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
    cacheWrite1h: Number(r.cache_write_1h),
    output: Number(r.output),
    reasoning: Number(r.reasoning),
    serverToolRequests: Number(r.server_tool_request),
    reportedCostMicros: r.cost_micros,
    basis: "client_attested",
  }));
}

/**
 * Every tool-call frame of one wrapped run, read in the run's own workspace
 * and its own sessions for the reasons {@link readModelCallFrames} gives. The
 * hook source is the one that carries a tool call once (the ingest handler's
 * `numToolCalls` rule); a ledger run's tool calls are its
 * `tool.call_completed` events in Postgres, which the rollup store reads.
 */
export async function readTachoToolCallFrames(args: {
  orgId: string;
  workspaceId: string;
  rootSessionUuid: string;
  /** The run's sessions, root first ({@link FrameRunRef}). */
  sessionUuids: readonly string[];
}): Promise<ToolCallFrameRow[]> {
  const ch = clickhouse();
  const result = await ch.query({
    query: `
      SELECT tool_name AS name
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND root_session_uuid = {rootSessionUuid:UUID}
        AND ${RUN_SESSIONS}
        AND kind = 'tool_call'
        AND source = 'hook'
      ORDER BY ts, seq
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: args.rootSessionUuid,
      sessionUuids: runSessions(args),
    },
    format: "JSONEachRow",
  });
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
  const result = await ch.query({
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
          AND ${receivedFrom("from")}
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
          AND ${receivedFrom("from")}
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
  });
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

/**
 * The token classes a model call can actually report today, across both
 * frame stores.
 *
 * `server_tool_request` is on this list because a wrapped agent's model-call
 * row DOES report it: `tacho_events.web_search_requests` counts the web
 * searches the vendor bills per request, and the book prices them at
 * `request` units ({@link import("@oxagen/billing").PRICE_UNIT_BY_TOKEN_CLASS}).
 * Leaving it off meant a model whose search requests nobody had priced was
 * never named by `list_unpriced_models`, so the one rate that made its runs
 * incomplete was the one rate the report stayed silent about (#3281). The
 * table's `web_fetch_requests` column is not part of the class, because the
 * vendor does not bill a fetch per request ({@link classBucketServerToolRequests}).
 *
 * `PriceTokenClass` (@oxagen/database/schema) also carries `image`,
 * `video_second`, `embedding_input` and `rerank`. No observation source in
 * this codebase reports usage in those four today, so this file does not
 * carry a dependency on @oxagen/database just to spell them, and this list
 * has nothing to omit them from: `findUnpricedModels` only ever checks a
 * class an observation actually used, so a class with no observation source
 * yet simply never appears. Adding a source for one of them is a one-line
 * addition here plus one to whichever query below produces it.
 */
export const OBSERVED_TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
  "server_tool_request",
] as const;
export type ObservedTokenClass = (typeof OBSERVED_TOKEN_CLASSES)[number];

/**
 * One token class's usage within one price-boundary bucket of one observed
 * model: how much of it ran, and the span of calls that used it, both bounded
 * to the bucket. Only classes and buckets that actually saw nonzero usage are
 * returned — a class a model never used, or a bucket with no calls in it, is
 * simply absent rather than a zero row.
 */
export interface ObservedModelClassRow {
  tokenClass: ObservedTokenClass;
  /** Model calls in this bucket that used this class. */
  calls: number;
  /**
   * Units of the class, which is what the book prices a million of: tokens
   * for every token class, and requests for `server_tool_request`.
   */
  tokens: number;
  /** RFC 3339. */
  firstSeen: string;
  /** RFC 3339. */
  lastSeen: string;
}

/** One model an organization has actually run, folded across both frame stores. */
export interface ObservedModelRow {
  model: string;
  /** Null when the frames name no vendor. */
  provider: string | null;
  /** Model calls seen in the window. */
  calls: number;
  /**
   * Total tokens across every token class, for ranking by how much the model
   * matters. Server tool requests are left out: they are requests, not
   * tokens, and adding a handful of them to a token count would rank a model
   * by a figure that means nothing. They appear in {@link classes}, which is
   * what the price comparison reads.
   */
  tokens: number;
  /** RFC 3339. */
  firstSeen: string;
  /** RFC 3339. */
  lastSeen: string;
  /**
   * This model's usage broken out by class and, when `boundaries` was given
   * to {@link readObservedModels}, by which boundary-bounded interval it fell
   * in — so a caller can test a price only against the classes a model
   * actually used, and only at the instants its book answer could have
   * differed, instead of a fixed class list judged by one snapshot.
   */
  classes: ObservedModelClassRow[];
}

/**
 * At most this many distinct models come back from one observed-models read.
 *
 * The bound is on the store read itself, against a pathological model-id
 * cardinality: a wrapped agent's free-form `model` field can carry anything,
 * and an unbounded GROUP BY handed to Node as rows, and then back to
 * ClickHouse as the `models` array of the class-bucket read, is the shape of
 * an outage. It is twenty times the 500 models an unpriced-model report shows,
 * because @oxagen/billing applies that cap AFTER filtering to the models the
 * book cannot price; a cap here at 500 would let a low-volume unpriced model
 * be outranked by priced, uninteresting ones and never reach the comparison.
 * #3629 removed the earlier 5000 bound for exactly that reason and left the
 * read unbounded. This one is higher, and it is not silent: a read that fills
 * it says so on stderr, which is what answers the objection that a bound
 * drops models nobody hears about.
 *
 * The bound applies to the ranked read only. The unpriced-model report walks
 * the keyset pages (`page`) instead, because a warning does not put a dropped
 * unpriced model back in the report (#3281).
 */
export const OBSERVED_MODEL_READ_BOUND = 10_000;

/** The one line this module writes when a read fills its bound. */
function noteObservedModelBoundHit(args: {
  orgId: string;
  workspaceId?: string;
}): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        msg: "cost-frames: observed-models read filled its bound; models past it are not priced or reported",
        alert: "observed_model_read_bound",
        bound: OBSERVED_MODEL_READ_BOUND,
        orgId: args.orgId,
        workspaceId: args.workspaceId ?? null,
      })}\n`,
    );
  } catch {
    // A logger never throws into the read it describes.
  }
}

/**
 * The interval index a timestamp falls in, given `boundaries` sorted
 * ascending: the count of boundaries at or before it. Boundary 0 covers
 * everything before the first boundary; the book's answer is constant within
 * one interval, so grouping by this index groups every row whose price-book
 * answer could not have differed.
 */
function bucketIndexExpr(tsColumn: string): string {
  return `arrayCount(b -> b <= ${tsColumn}, {boundaries:Array(DateTime64(3))})`;
}

/**
 * The reasoning figure a class-bucket row is credited with, mirroring
 * {@link FRAME_REASONING}: the transcript's thinking figure when a transcript
 * row joins, else the priced row's own column. Unlike {@link FRAME_REASONING},
 * this expression names its own row alias so it can be reused across the
 * gateway-shaped and tacho-shaped halves of the class-bucket query.
 */
function classBucketReasoning(rowAlias: string): string {
  return `toInt64(if(${TRANSCRIPT_THINKING} > 0, ${TRANSCRIPT_THINKING}, coalesce(${rowAlias}.thinking_tokens, 0)))`;
}
function classBucketCache1h(rowAlias: string, cacheWriteExpr: string): string {
  return `toInt64(least(${cacheWriteExpr}, if(${TRANSCRIPT_CACHE_1H} > 0, ${TRANSCRIPT_CACHE_1H}, coalesce(${rowAlias}.cache_creation_1h_tokens, 0))))`;
}

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
 * tacho sources carry each class separately and are simply added.
 * `thinking_tokens` is left out of that sum on purpose: the vendors count
 * thinking inside `output_tokens`, so adding it would count those tokens
 * twice and rank a reasoning model above models that need pricing more.
 * {@link readModelCallFrames} splits the two because they are priced at
 * different rates; a ranking only needs the total, which `output_tokens`
 * already carries.
 *
 * That is also why this read does not join the transcript's thinking figure
 * back the way {@link readModelCallFrames} does. The join exists there to
 * move tokens between two classes priced at different rates, and this sum
 * leaves thinking out of both, so the same join would change no total here.
 * The duplicate filter is the whole rule: it keeps one row per call, and
 * that row's `output_tokens` already counts the call's thinking once.
 *
 * Throws on a degraded store: a short list read off half the frames would
 * say a model is priced when nobody has priced it.
 *
 * A second read then breaks each returned model's usage out by class and,
 * when `boundaries` is given, by which price-boundary bucket it fell in
 * ({@link ObservedModelClassRow}) — so `findUnpricedModels` can compare a
 * price only against the classes a model actually used, at the instants its
 * book answer could actually have differed, instead of a fixed class list
 * judged by one snapshot. That read is skipped when the summary is empty,
 * and is scoped to exactly the models the summary named, so a book holding
 * boundaries for unrelated models never widens it. It reports every class of
 * {@link OBSERVED_TOKEN_CLASSES}, `server_tool_request` included, so a model
 * billed per provider-side web search is compared against the rate that
 * prices those requests and not only against its token rates.
 */
export async function readObservedModels(args: {
  orgId: string;
  workspaceId?: string;
  since: Date;
  /** Frames at or before this instant only; open-ended when omitted. */
  until?: Date;
  /**
   * Price-book boundaries ({@link import("@oxagen/billing").priceBookBoundaries})
   * to bucket usage by, sorted ascending. Omitted or empty puts every call in
   * one bucket per model and class, the whole window. Ignored when
   * {@link boundariesFor} is given.
   */
  boundaries?: readonly Date[];
  /**
   * The same list, chosen once the summary read has named the models the
   * organization actually ran, so a caller can hand in only the boundaries
   * that could move a price for THOSE models rather than the whole book's
   * history. Preferred over {@link boundaries} for that reason: the list is
   * scanned per frame, so an unrelated model's rate change would otherwise
   * both cost the scan and split this report into buckets whose price
   * answers are identical.
   */
  boundariesFor?: (
    models: readonly string[],
  ) => readonly Date[] | Promise<readonly Date[]>;
  /**
   * Which frame stores to read. `all` (the default) folds the gateway's
   * `token_usage` rows and the wrapped agents' `tacho_events` rows, which is
   * what a price-coverage report needs. `gateway` reads `token_usage` alone:
   * the population `get_usage_breakdown` aggregates, so a figure priced from
   * this read sits beside that breakdown's token totals without counting a
   * wrapped agent's calls the totals leave out.
   */
  frameStores?: "all" | "gateway";
  /**
   * Read one keyset page in model-id order instead of the ranked read.
   * `afterModel` is the last model id of the previous page (omitted for the
   * first page) and `size` is how many models the page holds at most. A page
   * shorter than `size` is the last one. A caller that must see every model,
   * such as the unpriced-model report, walks the pages: the ranked read stops
   * at {@link OBSERVED_MODEL_READ_BOUND} models by token volume, so a
   * low-volume model past it would never be read at all (#3281). The page
   * size also bounds the `models` array the class-bucket read receives.
   */
  page?: { afterModel?: string; size: number };
}): Promise<ObservedModelRow[]> {
  const ch = clickhouse();
  const withTacho = (args.frameStores ?? "all") === "all";
  const workspace =
    args.workspaceId === undefined
      ? ""
      : "AND workspace_id = {workspaceId:UUID}";
  const until =
    args.until === undefined ? "" : "AND {col} <= {until:DateTime64(3)}";
  const page = args.page;
  if (page !== undefined && !(Number.isInteger(page.size) && page.size > 0))
    throw new RangeError(
      `readObservedModels: page size must be a positive integer, got ${page.size}`,
    );
  const afterModel =
    page?.afterModel === undefined
      ? ""
      : "AND toString(model) > {afterModel:String}";
  const tachoWhere = `org_id = {orgId:UUID}
          AND ts >= {since:DateTime64(3)}
          ${until.replace("{col}", "ts")}
          AND ${TACHO_RECEIVED_SINCE}
          AND kind = 'llm_call'
          AND source IN {sources:Array(String)}
          AND ${NOT_A_DUPLICATE}
          AND model != ''
          ${workspace}`;
  const baseParams = {
    orgId: args.orgId,
    ...(args.workspaceId === undefined
      ? {}
      : { workspaceId: args.workspaceId }),
    since: chDateTime(args.since),
    ...(args.until === undefined ? {} : { until: chDateTime(args.until) }),
    sources: TACHO_TOKEN_SOURCES,
    duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
  };

  const tachoSummary = `
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
        WHERE ${tachoWhere}
          ${afterModel}
        GROUP BY toString(model), toString(provider)`;

  const summaryResult = await ch.query({
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
        FROM metered_token_usage
        WHERE org_id = {orgId:UUID}
          AND created_at >= {since:DateTime64(3)}
          ${until.replace("{col}", "created_at")}
          AND model != ''
          ${workspace}
          ${afterModel}
        GROUP BY toString(model), toString(provider)
        ${withTacho ? tachoSummary : ""}
      )
      GROUP BY model
      ORDER BY ${page === undefined ? "tokens DESC, model" : "model"}
      LIMIT {limit:UInt32}
    `,
    query_params: {
      ...baseParams,
      ...(page?.afterModel === undefined
        ? {}
        : { afterModel: page.afterModel }),
      limit: page === undefined ? OBSERVED_MODEL_READ_BOUND : page.size,
    },
    format: "JSONEachRow",
  });
  type SummaryRow = {
    model: string;
    provider: string;
    calls: string | number;
    tokens: string | number;
    first_seen: string;
    last_seen: string;
  };
  const summaryRows = (await summaryResult.json()) as SummaryRow[];
  // A full page is not a bound hit: the caller asks for the next page.
  if (page === undefined && summaryRows.length >= OBSERVED_MODEL_READ_BOUND)
    noteObservedModelBoundHit(args);
  if (summaryRows.length === 0) return [];

  const models = [...new Set(summaryRows.map((r) => r.model))];
  // The boundary list is chosen AFTER the summary named the models, so a
  // caller can narrow it to the models this organization actually ran. The
  // array is scanned once per frame by `bucketIndexExpr`, so handing in a
  // whole price catalog's history would cost every frame a scan over
  // boundaries no observed model could ever have been priced at, and would
  // fragment the report into buckets that differ only by an unrelated
  // model's rate change.
  const boundaryDates =
    args.boundariesFor === undefined
      ? (args.boundaries ?? [])
      : await args.boundariesFor(models);
  const boundaries = boundaryDates.map(chDateTime);
  const gatewayCacheWrite = "toInt64(coalesce(cache_write_tokens, 0))";
  const tachoCacheWrite = "toInt64(coalesce(c.cache_creation_tokens, 0))";
  const tachoCache1h = classBucketCache1h("c", tachoCacheWrite);
  const tachoCache5m = `toInt64(greatest(0, ${tachoCacheWrite} - ${tachoCache1h}))`;
  const tachoReasoning = classBucketReasoning("c");
  const tachoServerToolRequests = classBucketServerToolRequests("c");

  // The wrapped agents' transcript-split joins key on `session_uuid`, not on
  // `root_session_uuid`. A recorder's `LlmCallLedger` is its own, and a
  // subagent session records under its own `session_uuid` while sharing the
  // parent's root, so a request or message id reused across a parent and its
  // subagent would otherwise take `max()` over both and credit ONE call's
  // thinking and one-hour cache split to both. The id is unique within the
  // recorder that issued it, which is the session, so the session is the key.
  const tachoClassCte = `,
      tc AS (
        SELECT
          c.model                                                      AS model,
          c.provider                                                   AS provider,
          ${bucketIndexExpr("c.ts")}                                    AS bucket_index,
          toInt64(coalesce(c.input_tokens, 0))                         AS input_uncached,
          toInt64(coalesce(c.cache_read_tokens, 0))                    AS cache_read,
          ${tachoCache5m}                                               AS cache_write_5m,
          ${tachoCache1h}                                               AS cache_write_1h,
          toInt64(greatest(0, toInt64(coalesce(c.output_tokens, 0)) - ${tachoReasoning})) AS output,
          ${tachoReasoning}                                             AS reasoning,
          ${tachoServerToolRequests}                                    AS server_tool_request,
          c.ts                                                          AS ts
        FROM (
          SELECT
            toString(model) AS model, toString(provider) AS provider,
            toDateTime64(ts, 3, 'UTC') AS ts, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens,
            thinking_tokens, web_search_requests,
            request_id, message_id, session_uuid
          FROM tacho_events FINAL
          WHERE ${tachoWhere}
            AND model IN {models:Array(String)}
        ) AS c
        LEFT JOIN (
          SELECT
            request_id AS call_key,
            session_uuid AS session_uuid,
            toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
            toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h
          FROM tacho_events FINAL
          WHERE org_id = {orgId:UUID}
            AND ts >= {since:DateTime64(3)}
            ${until.replace("{col}", "ts")}
            AND ${TACHO_RECEIVED_SINCE}
            AND kind = 'llm_call'
            AND ${TRANSCRIPT_SPLIT_ROW}
          GROUP BY call_key, session_uuid
          HAVING call_key != ''
        ) AS t ON t.call_key = c.request_id AND t.session_uuid = c.session_uuid
        LEFT JOIN (
          SELECT
            message_id AS call_key,
            session_uuid AS session_uuid,
            toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
            toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h
          FROM tacho_events FINAL
          WHERE org_id = {orgId:UUID}
            AND ts >= {since:DateTime64(3)}
            ${until.replace("{col}", "ts")}
            AND ${TACHO_RECEIVED_SINCE}
            AND kind = 'llm_call'
            AND ${TRANSCRIPT_SPLIT_ROW}
          GROUP BY call_key, session_uuid
          HAVING call_key != ''
        ) AS m ON m.call_key = c.message_id AND m.session_uuid = c.session_uuid
      )`;

  const classResult = await ch.query({
    query: `
      WITH gw AS (
        SELECT
          toString(model)                                              AS model,
          toString(provider)                                           AS provider,
          ${bucketIndexExpr("toDateTime64(created_at, 3, 'UTC')")}      AS bucket_index,
          toInt64(greatest(0, toInt64(input_tokens) - toInt64(cached_tokens) - ${gatewayCacheWrite})) AS input_uncached,
          toInt64(coalesce(cached_tokens, 0))                          AS cache_read,
          ${gatewayCacheWrite}                                         AS cache_write_5m,
          toInt64(0)                                                   AS cache_write_1h,
          toInt64(coalesce(output_tokens, 0))                          AS output,
          toInt64(0)                                                   AS reasoning,
          toInt64(0)                                                   AS server_tool_request,
          toDateTime64(created_at, 3, 'UTC')                           AS ts
        FROM metered_token_usage
        WHERE org_id = {orgId:UUID}
          AND created_at >= {since:DateTime64(3)}
          ${until.replace("{col}", "created_at")}
          AND model IN {models:Array(String)}
          ${workspace}
      )${withTacho ? tachoClassCte : ""},
      unioned AS (
        SELECT model, bucket_index, input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning, server_tool_request, ts FROM gw
        ${withTacho ? "UNION ALL\n        SELECT model, bucket_index, input_uncached, cache_read, cache_write_5m, cache_write_1h, output, reasoning, server_tool_request, ts FROM tc" : ""}
      )
      SELECT
        model,
        tupleElement(class_token, 1)                                    AS class,
        bucket_index                                                    AS bucket_index,
        count()                                                         AS calls,
        sum(tupleElement(class_token, 2))                               AS tokens,
        formatDateTime(min(ts), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')         AS first_seen,
        formatDateTime(max(ts), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')         AS last_seen
      FROM unioned
      ARRAY JOIN
        [('input_uncached', input_uncached), ('cache_read', cache_read),
         ('cache_write_5m', cache_write_5m), ('cache_write_1h', cache_write_1h),
         ('output', output), ('reasoning', reasoning),
         ('server_tool_request', server_tool_request)] AS class_token
      WHERE tupleElement(class_token, 2) > 0
      GROUP BY model, class, bucket_index
      ORDER BY model, class, bucket_index
    `,
    query_params: { ...baseParams, models, boundaries },
    format: "JSONEachRow",
  });
  type ClassRow = {
    model: string;
    class: string;
    bucket_index: string | number;
    calls: string | number;
    tokens: string | number;
    first_seen: string;
    last_seen: string;
  };
  const classRows = (await classResult.json()) as ClassRow[];
  const classesByModel = new Map<string, ObservedModelClassRow[]>();
  for (const r of classRows) {
    const list = classesByModel.get(r.model) ?? [];
    list.push({
      tokenClass: r.class as ObservedTokenClass,
      calls: Number(r.calls),
      tokens: Number(r.tokens),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    });
    classesByModel.set(r.model, list);
  }

  return summaryRows.map((r) => ({
    model: r.model,
    provider: r.provider === "" ? null : r.provider,
    calls: Number(r.calls),
    tokens: Number(r.tokens),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    classes: classesByModel.get(r.model) ?? [],
  }));
}
