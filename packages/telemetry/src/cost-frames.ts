/**
 * cost-frames.ts — the per-frame reads the spend rollup is rebuilt from
 * (Mission Control spec §12.3; ADR-060 §3).
 *
 * Two stores hold model-call frames. A gateway-metered call is one
 * `token_usage` row keyed on the run it ran for (`execution_step_id`), priced
 * by the gateway: `gateway_observed`. A wrapped agent's call is one
 * `tacho_events` row of kind `llm_call`, reported by the harness:
 * `client_attested`, unless the loopback model proxy carried the call and sealed
 * it with `oxagen.metering: observed`, which reads `gateway_observed`. Both come back in one shape with the token classes of
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
 * @oxagen/recorder folds session totals by, so the rollup and the fold cannot
 * price a call a different number of times. Those sources carry cache writes
 * as one `cache_creation_tokens` figure; the 5m/1h split is a transcript
 * column (docs/specs/tacho/data-model.md §2.7). The book prices the two TTLs
 * at different rates, so the wrap below recovers the one-hour portion the
 * same way it recovers thinking: from the transcript row, joined back when
 * the duplicate filter dropped it. The remainder of `cache_creation_tokens`
 * is the five-minute write, matching `priceObservedUsage` in @oxagen/recorder.
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
 * figures, the same rule `countsLlmCallSplit` in @oxagen/recorder states.
 * Nothing is added by the join: the call is still priced from one row, and
 * the figures only move tokens between classes that row already counted.
 *
 * The token sources and the system context pull the same way (#4508). Only
 * the proxy recorded the request, so only the proxy's sighting carries
 * `tool_definition_tokens` and the system context digest and parts. An OTel
 * or transcript sighting that sealed first carries `steering_tokens`, from
 * the session's steering manifest, and `context_frame_tokens`, from the text
 * Oxagen's hooks handed the session, and only on a call of the session's own
 * conversation (ADR-062, amendments of 2026-10-02 and 2026-10-03). On a
 * session the proxy did not carry, that row is the only one, and the read
 * takes both counts from it. The proxy row is then the stamped one and the
 * filter drops it. The read joins it back on the same two ids
 * ({@link PROXY_SIGHTING}) and takes a member from it wherever the priced row
 * carries none. A side call declares no tools, so its proxy row carries no
 * steering either, and the join adds none to it. The sums still come from
 * the rows the rollup prices, in the same read.
 *
 * The findings job reads a workspace's tool calls with their digests and
 * result tokens through the same client (`readTachoToolCallObservations`).
 */
import type { ClickHouseSettings } from "@clickhouse/client";
import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LLM_CALL_TOKEN_SOURCES,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
  SYSTEM_CONTEXT_PARTS_MAX,
  systemContextPartSchema,
  type SystemContextPart,
} from "@oxagen/recorder";
import {
  ARRAY_PARAM_VALUES_MAX,
  ARRAY_PARAMS_MAX,
  sessionListFilter,
  splitArrayParam,
} from "./array-params";
import { clickhouse } from "./clickhouse";

// The run readers outside this package (packages/handlers) bound their
// session lists with these.
export { sessionBatches, sessionListFilter } from "./array-params";

/**
 * How a frame's cost is known. `estimated` is a frame a backfill rebuilt from
 * a transcript (ADR-161): the price book prices it at its own `ts`, and the
 * figure is an estimate of spend that happened before the host recorded it.
 */
type CostFrameBasis = "gateway_observed" | "client_attested" | "estimated";

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
  /**
   * The chain a wrapped frame was recorded on (`session_uuid`), which is the
   * root session for a call on the root's own chain. Absent on a gateway
   * frame, which has no chain.
   */
  sessionUuid?: string;
  /**
   * The tokens the call spent on tool definitions, context frames, and
   * steering, as the recorder measured them on the frame (#4493). Each is
   * null when the frame carried none. A ledger frame carries none: the gateway
   * does not measure them. They ride this read so the rollup sums them over
   * exactly the calls it prices.
   */
  toolDefinitionTokens: number | null;
  contextFrameTokens: number | null;
  steeringTokens: number | null;
  /**
   * The digest over the ordered parts of the call's system context
   * (`system_context_digest`). Absent on a ledger frame and on a wrapped frame
   * that carried none.
   */
  systemContextDigest?: string;
  /**
   * The parts that digest covers (`system_context_parts`), in request order.
   * Absent when the frame listed none, which is usual: the recorder lists them
   * once per digest, and a reader takes a frame's parts from the latest frame
   * at or before it whose digest matches and whose list is set. A list that
   * does not parse is absent too.
   */
  systemContextParts?: readonly SystemContextPart[];
  /**
   * The model proxy sent this call as a cache keep-alive while a parent run
   * waited on a subagent (`oxagen.cache_keep_alive`, lane F32). It is spend,
   * and no step the agent took. Absent on every other frame, a ledger frame
   * included.
   */
  cacheKeepAlive?: true;
  /**
   * The frame's place on its chain (`seq`). A chain numbers every event it
   * records from one counter, so a tool call's `seq` on the same chain orders
   * against it when the two share a millisecond. With `sessionUuid` it names
   * the `llm_call` event, and no later read changes either (#4506). Absent on
   * a ledger frame, which has no chain.
   */
  seq?: number;
}

const SYSTEM_CONTEXT_PARTS = systemContextPartSchema
  .array()
  .max(SYSTEM_CONTEXT_PARTS_MAX);

/**
 * A frame's system context parts from the column's JSON text, or undefined
 * when the column is empty or the text is not a valid list.
 */
export function parseSystemContextParts(
  text: string | null | undefined,
): readonly SystemContextPart[] | undefined {
  if (text === null || text === undefined || text === "") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = SYSTEM_CONTEXT_PARTS.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** A count ClickHouse returns for a Nullable column, or null when absent. */
function nullableCount(
  value: string | number | null | undefined,
): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * One tool call as the rollup reads it, in the shape of billing's
 * `ToolCallFrame`. The rollup grades the call from its status and digests
 * (#3984, ADR-199) and prices its result tokens (#3892). Each member is null
 * where the frame recorded none.
 */
interface ToolCallFrameRow {
  repeated?: boolean;
  /** Null when the frame names no tool. */
  name: string | null;
  /**
   * `tool_status` when it is `ok`, `error` or `rejected`. A `cancelled` call
   * and a frame that recorded no status read null: neither says the call
   * failed.
   */
  status: "ok" | "error" | "rejected" | null;
  /** Null when the hook recorded no digest. */
  inputDigest: string | null;
  outputDigest: string | null;
  /** The classifier's flag; null when it said nothing. */
  isMutating: boolean | null;
  /**
   * The call's result tokens: the count the OTel span of the same tool use
   * reported, else the estimate the hook row carries (#5339). Null when
   * neither recorded one.
   */
  resultTokens: number | null;
  /** Set only when `resultTokens` is the hook's estimate; see {@link RESULT_TOKENS_BASIS}. */
  resultTokensBasis?: "estimated";
  /**
   * When the hook recorded the call (RFC 3339), and the chain it ran on
   * (`session_uuid`, the root session on the root's own chain). The rollup
   * places each call under the model call that made it (F17). Absent when
   * the read returned neither.
   */
  at?: string;
  sessionUuid?: string;
}

/** The `tool_status` values a rollup grades on; `cancelled` is left out on purpose. */
const GRADED_TOOL_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "error",
  "rejected",
]);

function toolFrameStatus(status: string): ToolCallFrameRow["status"] {
  return GRADED_TOOL_STATUSES.has(status)
    ? (status as ToolCallFrameRow["status"])
    : null;
}

/**
 * A tool call's result tokens, for a read that joins the OTel tool span of the
 * call as `r` onto the hook row `h` (#5339). The span's count is Claude Code's
 * own, so it wins. A hook row carries the recorder's estimate, from the size
 * of the result the hook saw, for a call no span counted. `join_use_nulls`
 * makes an unmatched span read null, so the hook row fills in.
 */
const RESULT_TOKENS = "coalesce(r.result_tokens, h.tool_result_tokens)";

/**
 * How {@link RESULT_TOKENS} is known: `reported` for the span's count, the
 * hook row's own basis for its count, and empty when neither recorded one. A
 * hook row with a count and no basis reads `estimated`. Only the recorder
 * writes a hook row's count, and a count read as reported must be one Claude
 * Code stated, so the read never guesses `reported`.
 */
const RESULT_TOKENS_BASIS =
  "multiIf(r.result_tokens IS NOT NULL, 'reported', h.tool_result_tokens IS NULL, '', h.tool_result_tokens_basis = 'reported', 'reported', 'estimated')";

/** The basis member a row takes: set only for an estimate, absent for a count Claude Code reported. */
function resultTokensBasisOf(
  tokens: string | number | null,
  basis: string | undefined,
): { resultTokensBasis?: "estimated" } {
  return tokens !== null && basis === "estimated"
    ? { resultTokensBasis: "estimated" }
    : {};
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
 * (`countsLlmCallUsage` in @oxagen/recorder): a token-bearing source, transcript
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
 * message id (`llmCallKeys` in @oxagen/recorder). They are separate joins, not
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
 * The web-search count from the same transcript joins. The OTel and proxy
 * sources do not record it, so when one of them is the priced sighting, only
 * the call's transcript row carries its searches.
 */
const TRANSCRIPT_SEARCHES =
  "greatest(coalesce(t.searches, 0), coalesce(m.searches, 0))";

/**
 * The rows that carry a call's thinking and cache-TTL split, which is
 * `countsLlmCallSplit` in @oxagen/recorder spelled for the store: a transcript
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
 * remainder (`priceObservedUsage` in @oxagen/recorder).
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
 * When an OTel or proxy sighting is the priced row, it carries no search
 * count, so the figure comes from the call's transcript row through the joins
 * that carry thinking ({@link TRANSCRIPT_SEARCHES}). Both sightings describe one call, so
 * `greatest` picks the one figure there is. The frame read and the
 * class-bucket read both use this, so they cannot count differently.
 */
function classBucketServerToolRequests(rowAlias: string): string {
  return `toInt64(greatest(coalesce(${rowAlias}.web_search_requests, 0), ${TRANSCRIPT_SEARCHES}))`;
}
const FRAME_SERVER_TOOL_REQUESTS = classBucketServerToolRequests("c");

/**
 * Sessions one array parameter carries at most ({@link ARRAY_PARAM_VALUES_MAX}
 * in ./array-params.ts). A run whose family held a few thousand subagent
 * sessions failed every rollup and every findings pass on the URL field
 * limit when its whole list went in one parameter (#5311).
 */
export const RUN_SESSIONS_PER_PARAM = ARRAY_PARAM_VALUES_MAX;

/** Array parameters one read splits a run's sessions across at most. */
export const RUN_SESSIONS_PARAMS_MAX = ARRAY_PARAMS_MAX;

/**
 * The sessions that carry a run's root in its workspace, named by ClickHouse
 * itself. Every caller binds the three parameters it reads.
 */
const RUN_FAMILY_SESSIONS = `session_uuid IN (
            SELECT session_uuid FROM tacho_events
            WHERE org_id = {orgId:UUID}
              AND workspace_id = {workspaceId:UUID}
              AND root_session_uuid = {rootSessionUuid:UUID})`;

/**
 * The predicate that limits a wrapped run's read to its own chains, by the
 * table's sort key ({@link FrameRunRef}), and the parameters it binds.
 *
 * Up to {@link RUN_SESSIONS_PER_PARAM} sessions bind as one array parameter,
 * `sessionUuids`, as they always have. A longer list is split across
 * `sessionUuids`, `sessionUuids1`, `sessionUuids2` and on, so no URL field
 * passes the server's limit and the read still names each chain by the sort
 * key. A list longer than {@link RUN_SESSIONS_PARAMS_MAX} parameters hold is
 * not sent: the read takes the chains that carry the run's root in the
 * workspace, which are every chain the root predicate already admits. That
 * form costs a scan of the workspace's root column, so it is kept for a
 * family too large to name in the URL.
 *
 * Three other ways were weighed and left out. The root subquery for every
 * run brings back, on every read, the workspace scan #4103 removed. Raising
 * the server's field limit is a fleet setting that moves the wall and leaves
 * it. Writing the list into the SQL as literals hits the query size limit
 * instead, and puts values in the query text that a parameter keeps out.
 */
export function runSessionsFilter(sessions: readonly string[]): {
  sql: string;
  params: Record<string, string[]>;
} {
  return (
    sessionListFilter(sessions) ?? { sql: RUN_FAMILY_SESSIONS, params: {} }
  );
}

/**
 * The sighting of a model call the loopback proxy sealed. It is the one
 * sighting that saw the request, so the one that carries the call's token
 * sources and system context (#4493). This predicate does NOT apply
 * {@link NOT_A_DUPLICATE}: the proxy row the read needs is the stamped one
 * whenever another source sealed the call first.
 */
const PROXY_SIGHTING = "source = 'collector' AND fidelity = 'proxy'";

/**
 * The metering mark the loopback proxy seals on every call it carries
 * (`oxagen.metering: observed`). A row written before the mark existed, or by
 * a source the proxy never saw, reads an empty string. The names are fixed
 * constants, so they sit in the SQL as literals and add no query parameters.
 */
const METERING_VALUE = `attrs['${TACHO_METERING_ATTR}']`;

/**
 * The proxy saw the call when the priced row carries the mark or the proxy
 * sighting joined back to it does. The proxy sighting can be the unpriced one
 * (an OTel or hook row sealed the call first), so the join is read too. Returns
 * 1 for a call the proxy observed and 0 otherwise.
 */
const FRAME_PROXY_OBSERVED = `toUInt8(c.metering = '${TACHO_METERING_OBSERVED}' OR r.metering = '${TACHO_METERING_OBSERVED}' OR q.metering = '${TACHO_METERING_OBSERVED}')`;

/**
 * The mark the loopback proxy seals on a cache keep-alive it sent
 * (`KEEP_ALIVE_ATTR` in `packages/tacho/src/collector/cache-keep-alive.ts`).
 * The proxy seals the keep-alive's only sighting, so the priced row carries
 * it. A literal in the SQL, like the metering mark, so it adds no parameter.
 */
const CACHE_KEEP_ALIVE_VALUE = "attrs['oxagen.cache_keep_alive']";

/** The mark a backfilled frame carries (ADR-161, `RECORD_BASIS_ATTR`). */
const RECORD_BASIS_VALUE = "attrs['oxagen.record_basis']";

/**
 * The proxy sighting's token sources and system context, grouped on one
 * call id, for the join named `alias` on `c.<key>`. Keyed on each id apart
 * for the reason the transcript joins are (`TRANSCRIPT_THINKING`). The
 * aliases differ from the column names so a grouped column is never read
 * back as its own aggregate. `sessionsSql` is the run's
 * {@link runSessionsFilter} predicate.
 */
function proxySightingJoin(
  key: "request_id" | "message_id",
  alias: string,
  sessionsSql: string,
): string {
  return `LEFT JOIN (
        SELECT
          ${key} AS call_key,
          max(tool_definition_tokens) AS tool_definitions,
          max(context_frame_tokens) AS context_frames,
          max(steering_tokens) AS steering,
          max(${METERING_VALUE}) AS metering,
          max(system_context_digest) AS context_digest,
          argMax(system_context_parts, (system_context_digest, length(system_context_parts))) AS context_parts
        FROM tacho_events FINAL
        ${sortKeyPrewhere(sessionsSql)}
        WHERE root_session_uuid = {rootSessionUuid:UUID}
          AND kind = 'llm_call'
          AND ${PROXY_SIGHTING}
        GROUP BY call_key
        HAVING call_key != ''
      ) AS ${alias} ON ${alias}.call_key = c.${key}`;
}

/**
 * A token source count on the priced row, or the proxy sighting's when the
 * priced row carries none. `r` joins on the request id and `q` on the
 * message id. A LEFT JOIN that matches nothing reads a Nullable column as
 * null, so the count stays null when no row measured it.
 */
function proxiedCount(column: string, joined: string): string {
  return `coalesce(c.${column}, r.${joined}, q.${joined})`;
}

/**
 * The system context digest and its parts, from the priced row when it
 * carries a digest and otherwise from the proxy sighting. The parts always
 * come from the row the digest came from, so a digest never pairs with
 * another row's list. An unmatched join reads an empty string.
 */
const FRAME_CONTEXT_DIGEST =
  "if(c.system_context_digest != '', c.system_context_digest, if(r.context_digest != '', r.context_digest, q.context_digest))";
const FRAME_CONTEXT_PARTS =
  "if(c.system_context_digest != '', c.system_context_parts, if(r.context_digest != '', r.context_parts, q.context_parts))";

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
 * The transcript joins key on the call id alone, and the session predicate
 * keeps them inside this run's family. One ledger serves a session and its
 * subagents (ADR-168), so the proxy can seal a subagent's call on the root
 * chain while its transcript row sits on the child chain. A `session_uuid`
 * key would miss that pair.
 *
 * A wrapped frame carries the call's web searches as `server_tool_request`,
 * priced per request. Web fetches are not counted: the vendor does not charge
 * per fetch (#3721).
 *
 * A wrapped frame also names the chain it was recorded on and its `seq` on
 * that chain. `ts` keeps milliseconds, so two calls can share one instant.
 * The findings job tells two chains' requests apart by the chain, and two
 * requests of one chain apart by `seq`.
 *
 * A wrapped `llm_call` row that names no model is left out, since no price
 * covers it. `keepModelless` keeps it, with `model` empty: the findings job
 * reads it as the start of a request it cannot price, so the tool calls after
 * it do not join the request before it (#4506).
 */
/**
 * Per-query bounds keep spillable work below the service memory limit.
 *
 * Production ClickHouse runs in ClickHouse Cloud, on replicas of 8 GiB or
 * more (ADR-295). These bounds were 128 MiB, 16 MiB spill points, and 2
 * threads while it ran on the app node under a 1.5 GiB cap, and from
 * 2026-10-02 every findings pass and run-progress read failed against the
 * 128 MiB bound (#5395). A query may now take 1 GiB, an eighth of the smallest
 * replica, and spills to disk past 256 MiB, so one heavy read still cannot
 * crowd out ingest. The block size stays 256: it sets the batch the caller's
 * consumer receives, not the memory bound.
 */
export const COST_FRAME_QUERY_SETTINGS: ClickHouseSettings = {
  max_memory_usage: String(1024 * 1024 * 1024),
  max_bytes_before_external_group_by: String(256 * 1024 * 1024),
  max_bytes_before_external_sort: String(256 * 1024 * 1024),
  max_bytes_in_join: String(256 * 1024 * 1024),
  join_algorithm: "grace_hash",
  max_threads: 4,
  max_execution_time: 30,
  max_block_size: "256",
};

type FrameConsumer<T> = (frames: T[]) => Promise<void>;

/** Await each batch before reading more rows from ClickHouse. */
async function consumeFrames<Row, Frame>(
  result: {
    json(): Promise<unknown>;
    stream(): AsyncIterable<{ json(): unknown }[]>;
    close(): void;
  },
  convert: (row: Row) => Frame,
  consume?: FrameConsumer<Frame>,
): Promise<Frame[]> {
  if (consume === undefined) return ((await result.json()) as Row[]).map(convert);
  let batch: Frame[] = [];
  try {
    for await (const rows of result.stream()) {
      for (const row of rows) {
        batch.push(convert(row.json() as Row));
        if (batch.length === 256) {
          await consume(batch);
          batch = [];
        }
      }
    }
    if (batch.length > 0) await consume(batch);
    return [];
  } finally {
    result.close();
  }
}

export async function readModelCallFrames(args: {
  orgId: string;
  workspaceId: string;
  run: FrameRunRef;
  /** Keep a wrapped `llm_call` row that names no model; see above. */
  keepModelless?: boolean;
}, consume?: FrameConsumer<ModelCallFrameRow>): Promise<ModelCallFrameRow[]> {
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
    clickhouse_settings: COST_FRAME_QUERY_SETTINGS,
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
    return consumeFrames<Row, ModelCallFrameRow>(result, (r) => ({
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
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
    }), consume);
  }

  const sessions = runSessionsFilter(runSessions(run));
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
        c.cost_usd_micros AS cost_micros,
        toString(c.session_uuid) AS session_uuid,
        ${proxiedCount("tool_definition_tokens", "tool_definitions")} AS tool_definition_tokens,
        ${proxiedCount("context_frame_tokens", "context_frames")} AS context_frame_tokens,
        ${proxiedCount("steering_tokens", "steering")} AS steering_tokens,
        ${FRAME_CONTEXT_DIGEST} AS system_context_digest,
        ${consume === undefined ? FRAME_CONTEXT_PARTS : "NULL"} AS system_context_parts,
        ${FRAME_PROXY_OBSERVED} AS proxy_observed,
        toUInt8(c.keep_alive = '1') AS cache_keep_alive,
        toUInt8(c.record_basis = 'backfill') AS backfilled,
        c.seq AS seq
      FROM (
        SELECT
          ts, seq, session_uuid, model, provider, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens,
          thinking_tokens, web_search_requests, cost_usd_micros, request_id,
          message_id, tool_definition_tokens, context_frame_tokens,
          steering_tokens, system_context_digest, system_context_parts,
          ${METERING_VALUE} AS metering,
          ${CACHE_KEEP_ALIVE_VALUE} AS keep_alive,
          ${RECORD_BASIS_VALUE} AS record_basis
        FROM tacho_events FINAL
        ${sortKeyPrewhere(sessions.sql)}
        WHERE root_session_uuid = {rootSessionUuid:UUID}
          AND kind = 'llm_call'
          AND source IN {sources:Array(String)}
          AND ${NOT_A_DUPLICATE}
          ${args.keepModelless === true ? "" : "AND model != ''"}
      ) AS c
      LEFT JOIN (
        SELECT
          request_id AS call_key,
          toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
          toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h,
          toInt64(max(coalesce(web_search_requests, 0))) AS searches
        FROM tacho_events FINAL
        ${sortKeyPrewhere(sessions.sql)}
        WHERE root_session_uuid = {rootSessionUuid:UUID}
          AND kind = 'llm_call'
          AND ${TRANSCRIPT_SPLIT_ROW}
        GROUP BY call_key
        HAVING call_key != ''
      ) AS t ON t.call_key = c.request_id
      LEFT JOIN (
        SELECT
          message_id AS call_key,
          toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
          toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h,
          toInt64(max(coalesce(web_search_requests, 0))) AS searches
        FROM tacho_events FINAL
        ${sortKeyPrewhere(sessions.sql)}
        WHERE root_session_uuid = {rootSessionUuid:UUID}
          AND kind = 'llm_call'
          AND ${TRANSCRIPT_SPLIT_ROW}
        GROUP BY call_key
        HAVING call_key != ''
      ) AS m ON m.call_key = c.message_id
      ${proxySightingJoin("request_id", "r", sessions.sql)}
      ${proxySightingJoin("message_id", "q", sessions.sql)}
      ORDER BY c.ts, c.seq
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: run.rootSessionUuid,
      ...sessions.params,
      sources: TACHO_TOKEN_SOURCES,
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
    },
    format: "JSONEachRow",
    clickhouse_settings: COST_FRAME_QUERY_SETTINGS,
  });
  return consumeFrames<WrappedFrameDbRow, ModelCallFrameRow>(
    result,
    toWrappedFrameRow,
    consume,
  );
}

/** One wrapped frame as the store returns it, from either wrapped read. */
interface WrappedFrameDbRow {
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
  session_uuid: string;
  tool_definition_tokens?: string | number | null;
  context_frame_tokens?: string | number | null;
  steering_tokens?: string | number | null;
  system_context_digest?: string | null;
  system_context_parts?: string | null;
  proxy_observed?: string | number | null;
  cache_keep_alive?: string | number | null;
  backfilled?: string | number | null;
  seq?: string | number | null;
}

/**
 * A wrapped frame in the shape every reader takes. The run read and the group
 * read both map their rows here, so a frame reads the same whichever read
 * returned it (#5168).
 */
function toWrappedFrameRow(r: WrappedFrameDbRow): ModelCallFrameRow {
  const parts = parseSystemContextParts(r.system_context_parts);
  return {
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
    // A call a backfill rebuilt from a transcript is estimated (ADR-161).
    // A call the loopback proxy carried is gateway_observed. A row with no
    // mark (older rows, or a call the proxy never saw) stays client_attested.
    basis:
      Number(r.backfilled ?? 0) === 1
        ? "estimated"
        : Number(r.proxy_observed ?? 0) === 1
          ? "gateway_observed"
          : "client_attested",
    sessionUuid: r.session_uuid,
    toolDefinitionTokens: nullableCount(r.tool_definition_tokens),
    contextFrameTokens: nullableCount(r.context_frame_tokens),
    steeringTokens: nullableCount(r.steering_tokens),
    ...(r.system_context_digest
      ? { systemContextDigest: r.system_context_digest }
      : {}),
    ...(parts === undefined ? {} : { systemContextParts: parts }),
    ...(Number(r.cache_keep_alive ?? 0) === 1
      ? { cacheKeepAlive: true as const }
      : {}),
    ...(r.seq === undefined || r.seq === null ? {} : { seq: Number(r.seq) }),
  };
}

/** One wrapped run a group read names: its root session and every chain in it. */
export interface GroupFrameRun {
  rootSessionUuid: string;
  sessionUuids: readonly string[];
}

/** The predicate that limits a group read to its runs' roots. */
const GROUP_ROOTS = "root_session_uuid IN {rootSessionUuids:Array(UUID)}";

/**
 * The sessions that carry one of a group read's roots in its workspace,
 * named by ClickHouse itself, as {@link RUN_FAMILY_SESSIONS} does for one run.
 */
const GROUP_FAMILY_SESSIONS = `session_uuid IN (
            SELECT session_uuid FROM tacho_events
            WHERE org_id = {orgId:UUID}
              AND workspace_id = {workspaceId:UUID}
              AND ${GROUP_ROOTS})`;

/**
 * The PREWHERE of each of a frame read's five table reads (#5462): the
 * workspace and the read's sessions. Each one is a column of the table's
 * sort key, `(org_id, workspace_id, session_uuid, seq)`. A group read and a
 * single run's read both use it. On 2026-10-04 one run of about 2,000
 * subagent sessions scanned 6 million rows and passed 1 GiB the same way.
 *
 * A group read names up to 5,000 sessions with random ids. A granule holds
 * 8,192 rows of many sessions, so a list that long can touch most of the
 * workspace's granules, and the sort key index keeps every granule it
 * touches. In production on 2026-10-03 a group read scanned 6 to 14 million
 * rows, two to four times the rows the table holds.
 * Every read uses FINAL, and ClickHouse moves a WHERE condition to PREWHERE
 * under FINAL only when `optimize_move_to_prewhere_if_final` is on, which
 * older releases leave off. So each table read decoded every column it names,
 * `attrs` and `system_context_parts` among them, for every row of those
 * granules before it dropped another session's rows. With PREWHERE it reads
 * the sort key columns first, and the other columns only for the batch's own
 * sessions.
 *
 * FINAL allows a condition on the sort key before its merge: every version of
 * a row carries the same key, so the condition keeps all of a row's versions
 * or none of them, and FINAL keeps the same version it kept before. The root,
 * kind, source, and duplicate conditions stay in WHERE, after the merge.
 */
function sortKeyPrewhere(sessionsSql: string): string {
  return `PREWHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND ${sessionsSql}`;
}

/** One query of a group read: the roots it names and their sessions. */
interface GroupFrameBatch {
  roots: string[];
  sessions: string[];
}

/**
 * A group's runs in the batches one query reads each (#5311). A batch names
 * at most {@link ARRAY_PARAM_VALUES_MAX} roots, so the roots fit one URL
 * field, and at most {@link ARRAY_PARAM_VALUES_MAX} x
 * {@link ARRAY_PARAMS_MAX} sessions, so the sessions fit the split
 * {@link sessionListFilter} makes. A run with more sessions than that is read
 * alone, and its batch names its chains by its root instead. Every row
 * belongs to one run, and a run sits in one batch, so the batches' answers
 * together are the one read's. A group that fits one query is one batch.
 */
function groupFrameBatches(
  families: ReadonlyMap<string, ReadonlySet<string>>,
): GroupFrameBatch[] {
  const sessionsMax = ARRAY_PARAM_VALUES_MAX * ARRAY_PARAMS_MAX;
  const out: GroupFrameBatch[] = [];
  let batch: GroupFrameBatch = { roots: [], sessions: [] };
  let named = new Set<string>();
  for (const [root, sessions] of families) {
    const added = [...sessions].filter((s) => !named.has(s));
    if (
      batch.roots.length > 0 &&
      (batch.roots.length >= ARRAY_PARAM_VALUES_MAX ||
        batch.sessions.length + added.length > sessionsMax)
    ) {
      out.push(batch);
      batch = { roots: [], sessions: [] };
      named = new Set();
    }
    batch.roots.push(root);
    for (const s of sessions)
      if (!named.has(s)) {
        named.add(s);
        batch.sessions.push(s);
      }
  }
  if (batch.roots.length > 0) out.push(batch);
  return out;
}

/**
 * A transcript-split join for a group read, on the request id (`t`) or the
 * message id (`m`). It is the run read's join over every run of the group,
 * keyed on the call id and the run's root session, so one run's call ids
 * never meet another run's. The root key holds a subagent's sightings
 * together, as the run read's root predicate does (ADR-168). `sessionsSql`
 * names the batch's sessions.
 */
function groupTranscriptJoin(
  key: "request_id" | "message_id",
  alias: string,
  sessionsSql: string,
): string {
  return `LEFT JOIN (
        SELECT
          ${key} AS call_key,
          root_session_uuid AS root_session_uuid,
          toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
          toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h,
          toInt64(max(coalesce(web_search_requests, 0))) AS searches
        FROM tacho_events FINAL
        ${sortKeyPrewhere(sessionsSql)}
        WHERE ${GROUP_ROOTS}
          AND kind = 'llm_call'
          AND ${TRANSCRIPT_SPLIT_ROW}
        GROUP BY call_key, root_session_uuid
        HAVING call_key != ''
      ) AS ${alias} ON ${alias}.call_key = c.${key} AND ${alias}.root_session_uuid = c.root_session_uuid`;
}

/**
 * {@link proxySightingJoin} for a group read, keyed on the call id and the
 * run's root session for the reason {@link groupTranscriptJoin} gives.
 */
function groupProxySightingJoin(
  key: "request_id" | "message_id",
  alias: string,
  sessionsSql: string,
): string {
  return `LEFT JOIN (
        SELECT
          ${key} AS call_key,
          root_session_uuid AS root_session_uuid,
          max(tool_definition_tokens) AS tool_definitions,
          max(context_frame_tokens) AS context_frames,
          max(steering_tokens) AS steering,
          max(${METERING_VALUE}) AS metering,
          max(system_context_digest) AS context_digest,
          argMax(system_context_parts, (system_context_digest, length(system_context_parts))) AS context_parts
        FROM tacho_events FINAL
        ${sortKeyPrewhere(sessionsSql)}
        WHERE ${GROUP_ROOTS}
          AND kind = 'llm_call'
          AND ${PROXY_SIGHTING}
        GROUP BY call_key, root_session_uuid
        HAVING call_key != ''
      ) AS ${alias} ON ${alias}.call_key = c.${key} AND ${alias}.root_session_uuid = c.root_session_uuid`;
}

/**
 * Every model-call frame of a group of wrapped runs, in one query, by root
 * session (#5168). The findings job reads a recurring job's runs this way, so
 * a job of 2,500 runs costs one query instead of 2,500.
 *
 * Each run's frames are the frames {@link readModelCallFrames} returns for
 * that run alone, priced by the same expressions, in the same order, and
 * mapped to the same shape. Each frame keeps its chain and its `seq`, so it
 * keeps the key the findings job builds from them (#4506, #5156). The query
 * differs from the run read in four places:
 *
 * - It names every run's root (`root_session_uuid IN ...`) and every session
 *   of every run (`session_uuid IN ...`), so it still reads through the
 *   table's sort key (#4103).
 * - Each joined read keys on the call id and the root session, so a call id
 *   joins only rows of its own run.
 * - It returns each frame's root, and sorts by root, then time, then `seq`.
 * - It drops a row whose chain is not one of its own run's sessions. The run
 *   read never returns such a row, because it names one run's sessions alone.
 *
 * Every root the caller names has an entry, empty when the run has no frame.
 * A row that names no model is left out unless `keepModelless` keeps it, as
 * in the run read. Throws on a degraded store.
 *
 * A group too large for one request URL is read in batches of runs
 * ({@link groupFrameBatches}), one query each (#5311). A group of 2,500 runs
 * named every root and every session in two array parameters, far past
 * ClickHouse's 128 KiB field limit.
 */
export async function readGroupModelCallFrames(args: {
  orgId: string;
  workspaceId: string;
  runs: readonly GroupFrameRun[];
  /** Keep a wrapped `llm_call` row that names no model; see above. */
  keepModelless?: boolean;
}): Promise<Map<string, ModelCallFrameRow[]>> {
  const out = new Map<string, ModelCallFrameRow[]>();
  // Each run's sessions, by its root in lower case, the way ClickHouse prints
  // a UUID.
  const sessionsByRoot = new Map<
    string,
    { root: string; sessions: ReadonlySet<string> }
  >();
  for (const run of args.runs) {
    out.set(run.rootSessionUuid, []);
    sessionsByRoot.set(run.rootSessionUuid.toLowerCase(), {
      root: run.rootSessionUuid,
      sessions: new Set(runSessions(run).map((s) => s.toLowerCase())),
    });
  }
  if (sessionsByRoot.size === 0) return out;
  // Each root once, with every session the runs that name it list.
  const families = new Map<string, Set<string>>();
  for (const run of args.runs) {
    const family = families.get(run.rootSessionUuid) ?? new Set<string>();
    for (const session of runSessions(run)) family.add(session);
    families.set(run.rootSessionUuid, family);
  }

  const ch = clickhouse();
  for (const batch of groupFrameBatches(families)) {
    const rows = await readGroupFrameBatch(ch, args, batch);
    for (const r of rows) {
      const run = sessionsByRoot.get(r.run_root.toLowerCase());
      if (run === undefined || !run.sessions.has(r.session_uuid.toLowerCase()))
        continue;
      out.get(run.root)!.push(toWrappedFrameRow(r));
    }
  }
  return out;
}

/** One batch of a group read: the rows of its runs, each with its root. */
async function readGroupFrameBatch(
  ch: ReturnType<typeof clickhouse>,
  args: { orgId: string; workspaceId: string; keepModelless?: boolean },
  batch: GroupFrameBatch,
): Promise<(WrappedFrameDbRow & { run_root: string })[]> {
  // The rows a chain outside its own run's list carries are dropped above, so
  // naming the batch's chains by their roots returns the same frames.
  const sessions = sessionListFilter(batch.sessions) ?? {
    sql: GROUP_FAMILY_SESSIONS,
    params: {},
  };
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
        c.cost_usd_micros AS cost_micros,
        toString(c.session_uuid) AS session_uuid,
        ${proxiedCount("tool_definition_tokens", "tool_definitions")} AS tool_definition_tokens,
        ${proxiedCount("context_frame_tokens", "context_frames")} AS context_frame_tokens,
        ${proxiedCount("steering_tokens", "steering")} AS steering_tokens,
        ${FRAME_CONTEXT_DIGEST} AS system_context_digest,
        ${FRAME_CONTEXT_PARTS} AS system_context_parts,
        ${FRAME_PROXY_OBSERVED} AS proxy_observed,
        toUInt8(c.keep_alive = '1') AS cache_keep_alive,
        toUInt8(c.record_basis = 'backfill') AS backfilled,
        c.seq AS seq,
        toString(c.root_session_uuid) AS run_root
      FROM (
        SELECT
          ts, seq, session_uuid, root_session_uuid, model, provider,
          input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, cache_creation_1h_tokens, thinking_tokens,
          web_search_requests, cost_usd_micros, request_id, message_id,
          tool_definition_tokens, context_frame_tokens, steering_tokens,
          system_context_digest, system_context_parts,
          ${METERING_VALUE} AS metering,
          ${CACHE_KEEP_ALIVE_VALUE} AS keep_alive,
          ${RECORD_BASIS_VALUE} AS record_basis
        FROM tacho_events FINAL
        ${sortKeyPrewhere(sessions.sql)}
        WHERE ${GROUP_ROOTS}
          AND kind = 'llm_call'
          AND source IN {sources:Array(String)}
          AND ${NOT_A_DUPLICATE}
          ${args.keepModelless === true ? "" : "AND model != ''"}
      ) AS c
      ${groupTranscriptJoin("request_id", "t", sessions.sql)}
      ${groupTranscriptJoin("message_id", "m", sessions.sql)}
      ${groupProxySightingJoin("request_id", "r", sessions.sql)}
      ${groupProxySightingJoin("message_id", "q", sessions.sql)}
      ORDER BY c.root_session_uuid, c.ts, c.seq
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuids: batch.roots,
      ...sessions.params,
      sources: TACHO_TOKEN_SOURCES,
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
    },
    format: "JSONEachRow",
    clickhouse_settings: COST_FRAME_QUERY_SETTINGS,
  });
  return (await result.json()) as (WrappedFrameDbRow & { run_root: string })[];
}

/**
 * Every tool-call frame of one wrapped run, read in the run's own workspace
 * and its own sessions for the reasons {@link readModelCallFrames} gives. The
 * hook source is the one that carries a tool call once (the ingest handler's
 * `numToolCalls` rule); a ledger run's tool calls are its
 * `tool.call_completed` events in Postgres, which the rollup store reads.
 *
 * Each call comes with what the rollup grades it by (its status, its input and
 * output digests, and the classifier's mutating flag, ADR-199) and its result
 * tokens: the count the OTel tool span of the same tool use reported, joined
 * on `tool_use_id` the way {@link readTachoToolCallObservations} joins them,
 * else the hook row's own estimate (#5339). `join_use_nulls` makes a call with
 * no span read the hook's estimate, or null where the hook saw no result,
 * never 0: a zero would price the call's result at nothing rather than leave
 * it unrecorded. An estimate carries `resultTokensBasis: "estimated"`.
 */
export async function readTachoToolCallFrames(args: {
  orgId: string;
  workspaceId: string;
  rootSessionUuid: string;
  /** The run's sessions, root first ({@link FrameRunRef}). */
  sessionUuids: readonly string[];
}, consume?: FrameConsumer<ToolCallFrameRow>): Promise<ToolCallFrameRow[]> {
  const ch = clickhouse();
  const sessions = runSessionsFilter(runSessions(args));
  const result = await ch.query({
    query: `
      SELECT
        h.tool_name                                                    AS name,
        h.tool_status                                                  AS status,
        h.tool_input_digest                                            AS input_digest,
        h.tool_output_digest                                           AS output_digest,
        h.tool_is_mutating                                             AS is_mutating,
        formatDateTime(h.ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')           AS at,
        toString(h.session_uuid)                                       AS session_uuid,
        ${RESULT_TOKENS} AS result_tokens,
        ${RESULT_TOKENS_BASIS} AS result_tokens_basis
        ${consume === undefined ? "" : ", h.repeated AS repeated"}
      FROM (
        SELECT ts, seq, session_uuid, tool_name, tool_status, tool_input_digest,
               tool_output_digest, tool_is_mutating, tool_use_id,
               tool_result_tokens, tool_result_tokens_basis
               ${consume === undefined ? "" : `,
                 tool_name != '' AND tool_input_digest != '' AND tool_output_digest != '' AND
                 count() OVER (
                   PARTITION BY tool_name, tool_input_digest, tool_output_digest
                   ORDER BY ts, seq, session_uuid
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) > 1 AS repeated`}
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND root_session_uuid = {rootSessionUuid:UUID}
          AND ${sessions.sql}
          AND kind = 'tool_call'
          AND source = 'hook'
      ) AS h
      LEFT JOIN (
        SELECT tool_use_id, max(tool_result_tokens) AS result_tokens
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND root_session_uuid = {rootSessionUuid:UUID}
          AND ${sessions.sql}
          AND kind = 'tool_call'
          AND source = 'otel_span'
          AND tool_use_id != ''
          AND tool_result_tokens IS NOT NULL
        GROUP BY tool_use_id
      ) AS r ON r.tool_use_id = h.tool_use_id
      ORDER BY h.ts, h.seq
      SETTINGS join_use_nulls = 1
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: args.rootSessionUuid,
      ...sessions.params,
    },
    format: "JSONEachRow",
    clickhouse_settings: COST_FRAME_QUERY_SETTINGS,
  });
  type Row = {
    name: string;
    repeated?: boolean | number;
    status: string;
    input_digest: string;
    output_digest: string;
    is_mutating: boolean | null;
    result_tokens: string | number | null;
    result_tokens_basis?: string;
    at?: string;
    session_uuid?: string;
  };
  return consumeFrames<Row, ToolCallFrameRow>(result, (r) => ({
    name: r.name === "" ? null : r.name,
    ...(consume === undefined ? {} : { repeated: Boolean(r.repeated) }),
    status: toolFrameStatus(r.status),
    inputDigest: r.input_digest === "" ? null : r.input_digest,
    outputDigest: r.output_digest === "" ? null : r.output_digest,
    isMutating: r.is_mutating,
    resultTokens: r.result_tokens === null ? null : Number(r.result_tokens),
    ...resultTokensBasisOf(r.result_tokens, r.result_tokens_basis),
    ...(r.at === undefined ? {} : { at: r.at }),
    ...(r.session_uuid === undefined ? {} : { sessionUuid: r.session_uuid }),
  }), consume);
}

/**
 * One step of a wrapped run as the no-progress check reads it, in the run's
 * order: a hook tool call, or a file the harness said changed. A file change
 * carries nothing else, since the check only needs to know one happened.
 */
export type ProgressFrameRow =
  | { fileChanged: true }
  | {
      /** Null when the frame names no tool. */
      name: string | null;
      /** Null when the hook recorded no digest. */
      inputDigest: string | null;
      outputDigest: string | null;
      /** The classifier's flag; null when it said nothing. */
      isMutating: boolean | null;
    };

/**
 * A wrapped run's hook tool calls and `oxagen:file_changed` frames, oldest
 * first, in the run's own workspace and sessions (#4490). The no-progress
 * check counts identical calls in a row, and a file change between two of
 * them ends the row: the second call may read what the change wrote. The
 * rollup's read ({@link readTachoToolCallFrames}) leaves file changes out,
 * so the check reads its own.
 */
export async function readTachoProgressFrames(args: {
  orgId: string;
  workspaceId: string;
  rootSessionUuid: string;
  /** The run's sessions, root first ({@link FrameRunRef}). */
  sessionUuids: readonly string[];
}): Promise<ProgressFrameRow[]> {
  const ch = clickhouse();
  const sessions = runSessionsFilter(runSessions(args));
  const result = await ch.query({
    query: `
      SELECT
        kind               AS kind,
        tool_name          AS name,
        tool_input_digest  AS input_digest,
        tool_output_digest AS output_digest,
        tool_is_mutating   AS is_mutating
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND root_session_uuid = {rootSessionUuid:UUID}
        AND ${sessions.sql}
        AND (
          (kind = 'tool_call' AND source = 'hook')
          OR kind = 'oxagen:file_changed'
        )
      ORDER BY ts, seq
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: args.rootSessionUuid,
      ...sessions.params,
    },
    format: "JSONEachRow",
  });
  type Row = {
    kind: string;
    name: string;
    input_digest: string;
    output_digest: string;
    is_mutating: boolean | null;
  };
  const rows = (await result.json()) as Row[];
  return rows.map(
    (r): ProgressFrameRow =>
      r.kind === "tool_call"
        ? {
            name: r.name === "" ? null : r.name,
            inputDigest: r.input_digest === "" ? null : r.input_digest,
            outputDigest: r.output_digest === "" ? null : r.output_digest,
            isMutating: r.is_mutating,
          }
        : { fileChanged: true },
  );
}

/** One hook-recorded tool call of a wrapped run, as the findings job reads it. */
export interface ToolCallObservationRow {
  rootSessionUuid: string;
  /**
   * The chain the call was recorded on, so a finding can cite a subagent's
   * frame (#4001): `seq` counts on this chain, not the root's. Equal to
   * `rootSessionUuid` for a call on the root's own chain.
   */
  sessionUuid: string;
  /** RFC 3339. */
  at: string;
  seq: number;
  tool: string;
  /**
   * Empty when the hook recorded no input. Such a call is kept: it may have
   * done new work, so the request that made it must not read as all repeats
   * (#4506).
   */
  inputDigest: string;
  /** Empty when the hook recorded no output. */
  outputDigest: string;
  isMutating: boolean | null;
  /**
   * The result tokens the OTel tool span reported for the same tool use, else
   * the hook row's estimate (#5339); null when neither recorded any.
   */
  resultTokens: number | null;
  /** Set only when `resultTokens` is the hook's estimate. */
  resultTokensBasis?: "estimated";
  /**
   * `tool_status` when it is `ok`, `error` or `rejected`, as
   * {@link ToolCallFrameRow} reads it; null for any other value.
   */
  status: ToolCallFrameRow["status"];
  /**
   * `tool_error_class`, the first line of the error the hook recorded for a
   * failed call; null when it recorded none.
   */
  errorClass: string | null;
}

/** ClickHouse DateTime64 params want a space-separated, Z-less string. */
function chDateTime(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * A workspace's tool calls over [from, to), newest first, at most `limit`
 * (Mission Control spec §12.8; ADR-062). The hook source carries a call once
 * with its input and output digests, the classifier's mutating flag, its
 * status, and the error class of a failed call; the OTel tool span of the
 * same tool use carries its result tokens, joined on `tool_use_id`. A call
 * the hook recorded no input for is read too (#4506). Throws on a degraded
 * store: the findings job retries rather than detecting over missing frames.
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
        toString(h.session_uuid)                                       AS session_uuid,
        formatDateTime(h.ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')           AS at,
        h.seq                                                          AS seq,
        h.tool_name                                                    AS tool,
        h.tool_input_digest                                            AS input_digest,
        h.tool_output_digest                                           AS output_digest,
        h.tool_is_mutating                                             AS is_mutating,
        ${RESULT_TOKENS} AS result_tokens,
        ${RESULT_TOKENS_BASIS} AS result_tokens_basis,
        h.tool_status                                                  AS status,
        h.tool_error_class                                             AS error_class
      FROM (
        SELECT root_session_uuid, session_uuid, ts, seq, tool_name,
               tool_input_digest, tool_output_digest, tool_is_mutating,
               tool_use_id, tool_status, tool_error_class,
               tool_result_tokens, tool_result_tokens_basis
        FROM tacho_events FINAL
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND kind = 'tool_call'
          AND source = 'hook'
          AND ts >= {from:DateTime64(3)}
          AND ts < {to:DateTime64(3)}
          AND ${receivedFrom("from")}
          AND tool_name != ''
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
    session_uuid: string;
    at: string;
    seq: string | number;
    tool: string;
    input_digest: string;
    output_digest: string;
    is_mutating: boolean | null;
    result_tokens: string | number | null;
    result_tokens_basis?: string;
    status: string;
    error_class: string;
  };
  const rows = (await result.json()) as Row[];
  return rows.map((r) => ({
    rootSessionUuid: r.root_session_uuid,
    sessionUuid: r.session_uuid,
    at: r.at,
    seq: Number(r.seq),
    tool: r.tool,
    inputDigest: r.input_digest,
    outputDigest: r.output_digest,
    isMutating: r.is_mutating,
    resultTokens: r.result_tokens === null ? null : Number(r.result_tokens),
    ...resultTokensBasisOf(r.result_tokens, r.result_tokens_basis),
    status: toolFrameStatus(r.status),
    errorClass: r.error_class === "" ? null : r.error_class,
  }));
}

/** One `oxagen:file_changed` frame of a wrapped run, as the findings job reads it. */
export interface FileChangeRow {
  rootSessionUuid: string;
  /** The chain the frame was recorded on; equal to `rootSessionUuid` on the root's own chain. */
  sessionUuid: string;
  /** RFC 3339, to the microsecond the store printed. */
  at: string;
  seq: number;
}

/**
 * A workspace's `oxagen:file_changed` frames over [from, to), newest first,
 * at most `limit`. A harness writes one when a file it watches changes on
 * disk, whoever changed it. The findings job reads them to tell whether a
 * file changed between two identical failing calls, since the second call
 * may then fail for a new reason. Throws on a degraded store.
 */
export async function readTachoFileChanges(args: {
  orgId: string;
  workspaceId: string;
  from: Date;
  to: Date;
  limit: number;
}): Promise<FileChangeRow[]> {
  const ch = clickhouse();
  const result = await ch.query({
    query: `
      SELECT
        toString(root_session_uuid)                                  AS root_session_uuid,
        toString(session_uuid)                                       AS session_uuid,
        formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')           AS at,
        seq                                                          AS seq
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND kind = 'oxagen:file_changed'
        AND ts >= {from:DateTime64(3)}
        AND ts < {to:DateTime64(3)}
        AND ${receivedFrom("from")}
      ORDER BY ts DESC, seq DESC
      LIMIT {limit:UInt32}
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
    session_uuid: string;
    at: string;
    seq: string | number;
  };
  const rows = (await result.json()) as Row[];
  return rows.map((r) => ({
    rootSessionUuid: r.root_session_uuid,
    sessionUuid: r.session_uuid,
    at: r.at,
    seq: Number(r.seq),
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
  /**
   * The model's calls per price-boundary bucket, and how many of them read
   * the prompt cache. Present only when {@link readObservedModels} was asked
   * for `callBuckets`.
   */
  callBuckets?: ObservedCallBucketRow[];
}

/**
 * One price-boundary bucket of one observed model's calls. The class rows
 * cannot say how many calls read nothing from the cache, because one call can
 * use both `input_uncached` and `cache_read`. This row counts the calls once
 * each.
 */
export interface ObservedCallBucketRow {
  /** Model calls in the bucket. */
  calls: number;
  /** Of those calls, the ones that read anything from the prompt cache. */
  cacheReadCalls: number;
  /** RFC 3339: the bucket's first call. */
  firstSeen: string;
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
function bucketIndexExpr(tsColumn: string, parts: readonly string[]): string {
  // The list comes split across array parameters (#5311). The parts are
  // disjoint, so their counts add up to the count over the whole list.
  const counts = parts.map(
    (name) => `arrayCount(b -> b <= ${tsColumn}, {${name}:Array(DateTime64(3))})`,
  );
  return counts.length === 1 ? counts[0]! : `(${counts.join(" + ")})`;
}

/**
 * The price boundaries split into array parameters that each fit one URL
 * field ({@link splitArrayParam}). The hourly price book sync can move a
 * model's rate every hour, and about 3,600 boundaries fill one field, so one
 * parameter was not enough. Throws past the URL budget with the count, where
 * ClickHouse would refuse the request with a form error that names nothing.
 */
function boundaryParams(boundaries: readonly string[]): [string, string[]][] {
  const split = splitArrayParam("boundaries", boundaries);
  if (split === null)
    throw new RangeError(
      `readObservedModels: ${boundaries.length} price boundaries pass the request URL budget of ${ARRAY_PARAM_VALUES_MAX * ARRAY_PARAMS_MAX}`,
    );
  return split;
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
  /**
   * Also count each model's calls per bucket, and the calls that read the
   * cache ({@link ObservedModelRow.callBuckets}). The weekly standing context
   * price in @oxagen/billing prices a call that read nothing from the cache
   * at the input rate of its own bucket. One more query runs when this is set.
   */
  callBuckets?: boolean;
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
  const boundarySplit = boundaryParams(boundaryDates.map(chDateTime));
  const boundaryNames = boundarySplit.map(([name]) => name);
  const boundaries = Object.fromEntries(boundarySplit);
  const gatewayCacheWrite = "toInt64(coalesce(cache_write_tokens, 0))";
  const tachoCacheWrite = "toInt64(coalesce(c.cache_creation_tokens, 0))";
  const tachoCache1h = classBucketCache1h("c", tachoCacheWrite);
  const tachoCache5m = `toInt64(greatest(0, ${tachoCacheWrite} - ${tachoCache1h}))`;
  const tachoReasoning = classBucketReasoning("c");
  const tachoServerToolRequests = classBucketServerToolRequests("c");

  // The wrapped agents' transcript-split joins key on the call id and the
  // session family, `root_session_uuid`. One ledger serves a session and its
  // subagents (ADR-168), and it seals a subagent's call on the root chain
  // when the proxy saw it first while the transcript row sits on the child
  // chain. A `session_uuid` key would miss that pair and drop the call's
  // thinking, one-hour cache split, and searches. The key also names the
  // workspace, and a workspace-scoped read fences the joins to it, because a
  // host in another workspace can name the same root.
  const tachoClassCte = `,
      tc AS (
        SELECT
          c.model                                                      AS model,
          c.provider                                                   AS provider,
          ${bucketIndexExpr("c.ts", boundaryNames)}                     AS bucket_index,
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
            request_id, message_id, workspace_id, root_session_uuid
          FROM tacho_events FINAL
          WHERE ${tachoWhere}
            AND model IN {models:Array(String)}
        ) AS c
        LEFT JOIN (
          SELECT
            request_id AS call_key,
            workspace_id AS workspace_id,
            root_session_uuid AS root_session_uuid,
            toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
            toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h,
            toInt64(max(coalesce(web_search_requests, 0))) AS searches
          FROM tacho_events FINAL
          WHERE org_id = {orgId:UUID}
            AND ts >= {since:DateTime64(3)}
            ${until.replace("{col}", "ts")}
            AND ${TACHO_RECEIVED_SINCE}
            AND kind = 'llm_call'
            AND ${TRANSCRIPT_SPLIT_ROW}
            ${workspace}
          GROUP BY call_key, workspace_id, root_session_uuid
          HAVING call_key != ''
        ) AS t ON t.call_key = c.request_id AND t.workspace_id = c.workspace_id AND t.root_session_uuid = c.root_session_uuid
        LEFT JOIN (
          SELECT
            message_id AS call_key,
            workspace_id AS workspace_id,
            root_session_uuid AS root_session_uuid,
            toInt64(max(coalesce(thinking_tokens, 0))) AS thinking,
            toInt64(max(coalesce(cache_creation_1h_tokens, 0))) AS cache_1h,
            toInt64(max(coalesce(web_search_requests, 0))) AS searches
          FROM tacho_events FINAL
          WHERE org_id = {orgId:UUID}
            AND ts >= {since:DateTime64(3)}
            ${until.replace("{col}", "ts")}
            AND ${TACHO_RECEIVED_SINCE}
            AND kind = 'llm_call'
            AND ${TRANSCRIPT_SPLIT_ROW}
            ${workspace}
          GROUP BY call_key, workspace_id, root_session_uuid
          HAVING call_key != ''
        ) AS m ON m.call_key = c.message_id AND m.workspace_id = c.workspace_id AND m.root_session_uuid = c.root_session_uuid
      )`;

  const classResult = await ch.query({
    query: `
      WITH gw AS (
        SELECT
          toString(model)                                              AS model,
          toString(provider)                                           AS provider,
          ${bucketIndexExpr("toDateTime64(created_at, 3, 'UTC')", boundaryNames)} AS bucket_index,
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
    query_params: { ...baseParams, models, ...boundaries },
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

  const bucketsByModel =
    args.callBuckets === true
      ? await readCallBuckets({
          withTacho,
          tachoWhere,
          workspace,
          until,
          boundaryNames,
          params: { ...baseParams, models, ...boundaries },
        })
      : null;

  return summaryRows.map((r) => ({
    model: r.model,
    provider: r.provider === "" ? null : r.provider,
    calls: Number(r.calls),
    tokens: Number(r.tokens),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    classes: classesByModel.get(r.model) ?? [],
    ...(bucketsByModel === null
      ? {}
      : { callBuckets: bucketsByModel.get(r.model) ?? [] }),
  }));
}

/**
 * Each model's calls per price-boundary bucket, and the calls that read the
 * cache, for {@link readObservedModels} `callBuckets`. It reads the rows the
 * summary counted: the same stores, filters, and models. A call counts as a
 * cache read when it read at least one token from the cache, the rule the
 * class rows use for `cache_read`.
 */
async function readCallBuckets(args: {
  withTacho: boolean;
  tachoWhere: string;
  workspace: string;
  until: string;
  /** The array parameters the price boundaries are split across. */
  boundaryNames: readonly string[];
  params: Record<string, unknown>;
}): Promise<Map<string, ObservedCallBucketRow[]>> {
  const tachoCte = `,
      tc AS (
        SELECT
          c.model                                   AS model,
          ${bucketIndexExpr("c.ts", args.boundaryNames)} AS bucket_index,
          toInt64(coalesce(c.cache_read_tokens, 0)) AS cache_read,
          c.ts                                      AS ts
        FROM (
          SELECT
            toString(model) AS model,
            toDateTime64(ts, 3, 'UTC') AS ts,
            cache_read_tokens
          FROM tacho_events FINAL
          WHERE ${args.tachoWhere}
            AND model IN {models:Array(String)}
        ) AS c
      )`;
  const result = await clickhouse().query({
    query: `
      WITH gw AS (
        SELECT
          toString(model)                                         AS model,
          ${bucketIndexExpr("toDateTime64(created_at, 3, 'UTC')", args.boundaryNames)} AS bucket_index,
          toInt64(coalesce(cached_tokens, 0))                     AS cache_read,
          toDateTime64(created_at, 3, 'UTC')                      AS ts
        FROM metered_token_usage
        WHERE org_id = {orgId:UUID}
          AND created_at >= {since:DateTime64(3)}
          ${args.until.replace("{col}", "created_at")}
          AND model IN {models:Array(String)}
          ${args.workspace}
      )${args.withTacho ? tachoCte : ""},
      unioned AS (
        SELECT model, bucket_index, cache_read, ts FROM gw
        ${args.withTacho ? "UNION ALL\n        SELECT model, bucket_index, cache_read, ts FROM tc" : ""}
      )
      SELECT
        model,
        bucket_index                                            AS bucket_index,
        count()                                                 AS calls,
        countIf(cache_read > 0)                                 AS cache_read_calls,
        formatDateTime(min(ts), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS first_seen
      FROM unioned
      GROUP BY model, bucket_index
      ORDER BY model, bucket_index
    `,
    query_params: args.params,
    format: "JSONEachRow",
  });
  type BucketRow = {
    model: string;
    bucket_index: string | number;
    calls: string | number;
    cache_read_calls: string | number;
    first_seen: string;
  };
  const rows = (await result.json()) as BucketRow[];
  const byModel = new Map<string, ObservedCallBucketRow[]>();
  for (const r of rows) {
    const list = byModel.get(r.model) ?? [];
    list.push({
      calls: Number(r.calls),
      cacheReadCalls: Number(r.cache_read_calls),
      firstSeen: r.first_seen,
    });
    byModel.set(r.model, list);
  }
  return byModel;
}
