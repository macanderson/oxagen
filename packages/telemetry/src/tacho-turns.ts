/**
 * The reads behind a wrapped run's per-turn ledger (`get_run_turns`, #4067).
 *
 * The Cost tab used to add up a run's turns from its transcript, read 200
 * entries at a time: 68 reads for a 250,000-frame run, and the transcript
 * stops folding at 10,000 frames. These two reads answer the same figures from
 * the run's frames in ClickHouse, grouped where they are stored, so a run of
 * any length costs the same two queries.
 *
 * {@link selectTachoTurnFacts} reads, per chain, the frames a turn opens on
 * and the first model call the proxy observed. {@link selectTachoTurnGroups}
 * then groups every frame of the run by the turn it falls in, which it finds
 * with `roundDown(seq, starts)`: the largest turn-opening seq at or below the
 * frame's own. Each chain of a subagent comes back as one group, because its
 * whole chain sits inside the turn that spawned it; the caller places it.
 *
 * The counting rules are the transcript's, spelled for the store:
 *
 * - A later sighting of a model call (`oxagen.llm_call_duplicate_of`, set on
 *   the second and later source to report one call, and on a transcript
 *   message's further content blocks) carries no cost and no usage, and is
 *   not another model call. `tachoFrame` in @oxagen/run-ledger reads it the
 *   same way.
 * - Once the proxy has observed one of a chain's model calls, a harness's own
 *   report of a later call on that chain carries no cost and no usage: the
 *   rule `get_run_transcript` applies per chain before it folds.
 * - A tool call is one per call id on its chain, however many frames record
 *   it (the gate, the request, the harness check, the result and the copies
 *   an OTel log and a transcript add).
 * - A tool call with no call id is the fold's rule 3, read from the chain's
 *   frames in seq order: a request pairs with the receipt of its own spelling
 *   when nothing but gates sits between them, and any other request or
 *   receipt is a call of its own. The caller passes the fold's vocabulary for
 *   that rule (`UNKEYED_TOOL_PAIRING` in @oxagen/run-ledger), so the two read
 *   the same kinds (ADR-190). A later sighting of a model call is left out of
 *   that reading, as the fold hides it before it pairs.
 *
 * Both reads go through `chSelect`, so each is fenced to the caller's
 * organization and workspace and served from the organization's data plane.
 */
import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LLM_CALL_TOKEN_SOURCES,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
} from "@oxagen/tacho";
import { TACHO_EVENTS_TABLE } from "./tacho-events-ddl";
import { chSelect } from "./tenant";

/** A model call the loopback proxy sealed and priced: `usageObserved` on a run frame. */
const OBSERVED = `kind = 'llm_call' AND source = 'collector' AND fidelity = 'proxy'
  AND attrs[{meteringAttr:String}] = {observed:String}`;

/** Where each chain's turns open, and where the proxy began observing it. */
export interface TachoChainTurnFacts {
  sessionUuid: string;
  /** The seq of every `turn_start` on the chain, ascending. */
  turnStarts: number[];
  /**
   * The first seq recorded under each turn index (`turn_seq`), ascending by
   * seq. A recording with no `turn_start` opens its turns where the index
   * changes, and this is where each index first appears.
   */
  turnIndexStarts: number[];
  /** The chain's first seq. A chain with no frames has no row. */
  firstSeq: number;
  /** The seq of the first model call the proxy observed on the chain; null when it observed none. */
  firstObservedSeq: number | null;
}

interface RawChainFacts {
  chain: string;
  starts: (string | number)[];
  index_starts: [unknown[], (string | number)[]] | null;
  first_seq: string | number;
  observed: string | number;
  first_observed: string | number;
}

/**
 * Per chain of `sessionUuids`, where its turns open and where the proxy began
 * observing its model calls. A chain with no frames is absent.
 */
export async function selectTachoTurnFacts(args: {
  sessionUuids: readonly string[];
}): Promise<TachoChainTurnFacts[]> {
  if (args.sessionUuids.length === 0) return [];
  const res = await chSelect<RawChainFacts>({
    query: `
      SELECT
        toString(session_uuid) AS chain,
        arraySort(groupArrayIf(seq, kind = 'turn_start')) AS starts,
        minMapIf([assumeNotNull(turn_seq)], [seq], turn_seq IS NOT NULL) AS index_starts,
        min(seq) AS first_seq,
        countIf(${OBSERVED}) AS observed,
        minIf(seq, ${OBSERVED}) AS first_observed
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE session_uuid IN {sessionUuids:Array(UUID)}
      GROUP BY chain
    `,
    params: {
      sessionUuids: [...args.sessionUuids],
      meteringAttr: TACHO_METERING_ATTR,
      observed: TACHO_METERING_OBSERVED,
    },
  });
  return res.data.map((r) => {
    const indexSeqs = (r.index_starts?.[1] ?? []).map(Number);
    return {
      sessionUuid: r.chain,
      turnStarts: r.starts.map(Number),
      turnIndexStarts: [...new Set(indexSeqs)].sort((a, b) => a - b),
      firstSeq: Number(r.first_seq),
      firstObservedSeq:
        Number(r.observed) > 0 ? Number(r.first_observed) : null,
    };
  });
}

/** A `subagent_start` frame: the chain it spawned is named by these. */
export interface TachoSpawnFact {
  seq: number;
  /** The spawning tool call's id; null when the frame recorded none. */
  toolUseId: string | null;
  /** The harness's id for the subagent (`hook.agent_id`); null when unrecorded. */
  subagentId: string | null;
}

/** Rule 3's vocabulary: each request with its receipt, and the gates between. */
export interface UnkeyedToolPairing {
  readonly closes: ReadonlyArray<readonly [request: string, receipt: string]>;
  readonly gates: readonly string[];
}

/**
 * The pattern an unkeyed tool call makes in a chain's frames, one letter per
 * frame: the kth request spelling is the kth capital, its receipt the same
 * lowercase letter, a gate `g`, and anything else `x`. `Ag*a` is a request,
 * any gates, and its receipt.
 */
export function unkeyedToolPattern(pairing: UnkeyedToolPairing): string {
  if (pairing.closes.length === 0 || pairing.closes.length > 26) {
    throw new Error(
      `rule 3 needs between 1 and 26 request spellings, got ${pairing.closes.length}`,
    );
  }
  return pairing.closes
    .map((_, k) => {
      const letter = String.fromCharCode(65 + k);
      return `${letter}g*${letter.toLowerCase()}`;
    })
    .join("|");
}

/** One chain's frames within one turn, counted. */
export interface TachoTurnGroup {
  sessionUuid: string;
  /**
   * The seq of the root frame the group's turn opens on. Null for a subagent
   * chain, which comes back whole, and for the root's frames recorded before
   * its first turn.
   */
  turnKey: number | null;
  /** The group's first frame, and when it was recorded (ClickHouse DateTime64 text, UTC). */
  firstSeq: number;
  firstAt: string;
  frames: number;
  /** Model calls, each counted once: `llm_call` frames that are no later sighting. */
  modelCalls: number;
  /** Distinct tool call ids among the tool frames. */
  keyedToolCalls: number;
  /**
   * Tool calls among the frames that carry no call id, paired by rule 3:
   * requests and receipts, less the pairs a request and its receipt make.
   */
  unkeyedToolCalls: number;
  /** The group's cost records summed, micro-USD; null when none counts. */
  costMicros: number | null;
  /** Reported input tokens, uncached and read from the cache; null when no call reported them. */
  inputUncached: number | null;
  cacheRead: number | null;
  /** The `subagent_start` frames in the group, ascending by seq. */
  spawns: TachoSpawnFact[];
  /** The chain's own facts, read from its first frame in the group. */
  parentSessionUuid: string | null;
  subagentId: string | null;
  spawnToolUseId: string | null;
}

interface RawTurnGroup {
  chain: string;
  turn_key: string | number;
  first_seq: string | number;
  first_at: string;
  frames: string | number;
  model_calls: string | number;
  keyed_tools: string | number;
  unkeyed_tools: string | number;
  cost_micros: string | number | null;
  priced: string | number;
  input_uncached: string | number | null;
  input_reported: string | number;
  cache_read: string | number | null;
  cache_reported: string | number;
  spawns: [string | number, string, string][];
  parent: string | null;
  subagent_id: string;
  spawn_tool_use_id: string;
}

/** A harness's report of a model call on a chain the proxy was already observing. */
const LATE_REPORT = `kind = 'llm_call' AND NOT (${OBSERVED})
  AND indexOf({observedChains:Array(String)}, toString(session_uuid)) > 0
  AND seq > {observedSeqs:Array(UInt64)}[indexOf({observedChains:Array(String)}, toString(session_uuid))]`;

/** A later sighting of a model call, or a transcript message's further block. */
const LATER_SIGHTING = `kind = 'llm_call' AND attrs[{duplicateAttr:String}] != ''`;

/** A cost record the turn counts. */
const PRICED = `cost_usd_micros IS NOT NULL AND NOT (${LATER_SIGHTING}) AND NOT (${LATE_REPORT})`;

/** A model call whose reported tokens the turn counts (`countsLlmCallUsage`, then the late-report rule). */
const COUNTED = `kind = 'llm_call' AND source IN {sources:Array(String)}
  AND attrs[{duplicateAttr:String}] = '' AND NOT (${LATE_REPORT})`;

const blank = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === "" ? null : value;

const nullableCount = (
  value: string | number | null,
  reported: string | number,
): number | null =>
  Number(reported) > 0 && value !== null ? Number(value) : null;

/** A tool frame that carries no call id: a request, a receipt, or neither. */
const UNKEYED = `tool_use_id = ''`;

/**
 * A decision about a call, as the fold reads it. An OTel adapter once sealed
 * Claude Code's own permission check as `policy_decision` with a policy
 * source of `harness`, and the fold reads that row as `harness_permission`
 * (`tachoKind`), which is not a gate.
 */
const GATE = `has({gates:Array(String)}, kind)
  AND NOT (kind = 'policy_decision' AND startsWith(source, 'otel')
    AND JSONExtractString(body, 'policy_source') = 'harness')`;

/** Each frame's letter in the rule 3 pattern (`unkeyedToolPattern`). */
const LETTER = `multiIf(
  tool_use_id != '', 'x',
  indexOf({toolRequests:Array(String)}, kind) > 0,
    char(64 + indexOf({toolRequests:Array(String)}, kind)),
  indexOf({toolReceipts:Array(String)}, kind) > 0,
    char(96 + indexOf({toolReceipts:Array(String)}, kind)),
  ${GATE}, 'g',
  'x')`;

/**
 * Every frame of a wrapped run, counted per chain and turn.
 *
 * `turnStarts` are the root seqs its turns open on, ascending and not empty.
 * A root frame falls in the turn of the largest of them at or below its own
 * seq; one before the first falls in none. `observedFrom` is each chain's
 * first proxy-observed model call, from {@link selectTachoTurnFacts}.
 * `pairing` is the fold's rule 3 vocabulary (`UNKEYED_TOOL_PAIRING`).
 */
export async function selectTachoTurnGroups(args: {
  rootSessionUuid: string;
  /** The run's chains, its own included. */
  sessionUuids: readonly string[];
  turnStarts: readonly number[];
  observedFrom: readonly { sessionUuid: string; seq: number }[];
  pairing: UnkeyedToolPairing;
}): Promise<TachoTurnGroup[]> {
  if (args.sessionUuids.length === 0 || args.turnStarts.length === 0) return [];
  const pattern = unkeyedToolPattern(args.pairing);
  const toolRequests = args.pairing.closes.map(([request]) => request);
  const toolReceipts = args.pairing.closes.map(([, receipt]) => receipt);
  const res = await chSelect<RawTurnGroup>({
    query: `
      SELECT
        toString(session_uuid) AS chain,
        if(session_uuid = {rootSessionUuid:UUID} AND seq >= {firstStart:UInt64},
          toInt64(roundDown(seq, {turnStarts:Array(UInt64)})), -1) AS turn_key,
        min(seq) AS first_seq,
        toString(argMin(ts, seq)) AS first_at,
        count() AS frames,
        countIf(kind = 'llm_call' AND NOT (${LATER_SIGHTING})) AS model_calls,
        uniqExactIf(tool_use_id,
          (has({toolRequests:Array(String)}, kind) OR has({toolReceipts:Array(String)}, kind))
          AND tool_use_id != '') AS keyed_tools,
        countIf((has({toolRequests:Array(String)}, kind) OR has({toolReceipts:Array(String)}, kind))
          AND ${UNKEYED})
          - countMatches(
              arrayStringConcat(arrayMap(f -> f.2, arraySort(f -> f.1,
                groupArrayIf((seq, ${LETTER}), NOT (${LATER_SIGHTING}))))),
              {pattern:String}) AS unkeyed_tools,
        sumIf(cost_usd_micros, ${PRICED}) AS cost_micros,
        countIf(${PRICED}) AS priced,
        sumIf(input_tokens, ${COUNTED} AND input_tokens IS NOT NULL) AS input_uncached,
        countIf(${COUNTED} AND input_tokens IS NOT NULL) AS input_reported,
        sumIf(cache_read_tokens, ${COUNTED} AND cache_read_tokens IS NOT NULL) AS cache_read,
        countIf(${COUNTED} AND cache_read_tokens IS NOT NULL) AS cache_reported,
        arraySort(s -> s.1, groupArrayIf(
          (seq, if(tool_use_id != '', tool_use_id, JSONExtractString(body, 'tool_use_id')), attrs['hook.agent_id']),
          kind = 'subagent_start')) AS spawns,
        toString(argMin(parent_session_uuid, seq)) AS parent,
        argMin(subagent_id, seq) AS subagent_id,
        argMin(spawn_tool_use_id, seq) AS spawn_tool_use_id
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE session_uuid IN {sessionUuids:Array(UUID)}
      GROUP BY chain, turn_key
    `,
    params: {
      rootSessionUuid: args.rootSessionUuid,
      sessionUuids: [...args.sessionUuids],
      turnStarts: [...args.turnStarts],
      firstStart: args.turnStarts[0],
      observedChains: args.observedFrom.map((o) => o.sessionUuid),
      observedSeqs: args.observedFrom.map((o) => o.seq),
      meteringAttr: TACHO_METERING_ATTR,
      observed: TACHO_METERING_OBSERVED,
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
      sources: [...LLM_CALL_TOKEN_SOURCES],
      toolRequests,
      toolReceipts,
      gates: [...args.pairing.gates],
      pattern,
    },
  });
  return res.data.map((r) => {
    const key = Number(r.turn_key);
    return {
      sessionUuid: r.chain,
      turnKey: key < 0 ? null : key,
      firstSeq: Number(r.first_seq),
      firstAt: r.first_at,
      frames: Number(r.frames),
      modelCalls: Number(r.model_calls),
      keyedToolCalls: Number(r.keyed_tools),
      unkeyedToolCalls: Number(r.unkeyed_tools),
      costMicros: nullableCount(r.cost_micros, r.priced),
      inputUncached: nullableCount(r.input_uncached, r.input_reported),
      cacheRead: nullableCount(r.cache_read, r.cache_reported),
      spawns: r.spawns.map(([seq, toolUseId, subagentId]) => ({
        seq: Number(seq),
        toolUseId: blank(toolUseId),
        subagentId: blank(subagentId),
      })),
      parentSessionUuid: blank(r.parent),
      subagentId: blank(r.subagent_id),
      spawnToolUseId: blank(r.spawn_tool_use_id),
    };
  });
}
