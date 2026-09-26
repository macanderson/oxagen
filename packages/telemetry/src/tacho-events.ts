/**
 * Append `tacho/1.0` events to ClickHouse `tacho_events`.
 *
 * The row is the package's own flattening of the event (every body member to
 * its column, the whole body as JSON text, unpromoted attributes in the map),
 * projected through the generated column list so an untyped caller cannot
 * smuggle a column that does not exist. Tenant labels are absent by
 * construction: chInsert stamps the authenticated ambient scope, and
 * `chain_verified` is the control plane's verdict, never the producer's.
 */
import {
  ENVELOPE_COLUMNS,
  flattenEvent,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
  type TachoEvent,
} from "@oxagen/tacho";
import type { ClickHouseSettings } from "@clickhouse/client";
import { TACHO_EVENTS_TABLE, tachoEventsColumns } from "./tacho-events-ddl";
import { chInsert, chSelect } from "./tenant";

export interface TachoEventInsert {
  event: TachoEvent;
  /** The control plane recomputed the hash and the link to the prior row. */
  chainVerified: boolean;
  /**
   * Where the control plane wrote the frame's body (ADR-058). Server-owned:
   * the envelope's own `content.bytes_ref`, if a producer set one, names a
   * producer-side location and is replaced by this, or by the empty string
   * when no body was retained.
   */
  bytesRef?: string;
}

const WRITABLE_COLUMNS: ReadonlySet<string> = new Set(
  tachoEventsColumns()
    .map((column) => column.name)
    .filter(
      (name) =>
        name !== "org_id" && name !== "workspace_id" && name !== "received_at",
    ),
);

/** One event as the row ClickHouse receives, minus the stamped tenant columns. */
export function tachoEventRow(
  insert: TachoEventInsert,
  receivedAt: string,
): Record<string, unknown> {
  const flat = flattenEvent(insert.event);
  const row: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(flat)) {
    if (WRITABLE_COLUMNS.has(column)) {
      row[column] = value;
    }
  }
  row["chain_verified"] = insert.chainVerified;
  row["received_at"] = receivedAt;
  row["bytes_ref"] = insert.bytesRef ?? "";
  return row;
}

/** The most memory one `tacho_events` insert may take: 512 MiB. */
export const TACHO_EVENTS_INSERT_MAX_MEMORY_BYTES = 512 * 1024 * 1024;

/**
 * The memory terms of every `tacho_events` insert (#3662).
 *
 * The app node's ClickHouse stops queries once the whole server passes its
 * 1.5 GiB cap. It picks the query with the highest overcommit ratio (bytes
 * held over the query's ratio denominator) and stops it. On 2026-09-21 it
 * picked the ingest insert while a heavy read held the memory, and the batch
 * failed. A denominator of 0 takes a query out of that choice, so a heavy read
 * elsewhere on the node is stopped instead of the write. ClickHouse's docs
 * disagree about which of the two denominators the server-wide choice reads,
 * so both are 0.
 *
 * In exchange, the insert is bounded by `max_memory_usage`, so a write the
 * node will not stop cannot grow without limit. One request is at most 4 MiB
 * of JSON (`TACHO_MAX_REQUEST_BYTES`), and 512 MiB is a third of the cap. An
 * insert that passes the bound fails with code 241, which ingest answers 503
 * with Retry-After.
 *
 * Measured (#4316), on ClickHouse 24.8 as CI runs it: a full request of the
 * smallest frames, 5,692 frames in 4 MiB of JSON, peaks at 76 MiB once
 * migration 0033 keeps every insert in the compact part layout. Before 0033
 * the same batch wrote a wide part and failed at the 512 MiB bound every
 * time. `tacho-events-insert.integration.test.ts` repeats the measurement on
 * every CI run and prints it. Production's own week of inserts is not
 * recorded here: its ClickHouse logs reach CloudWatch at warning level, with
 * no per-query memory, and the table held no rows on 2026-09-25.
 */
export const TACHO_EVENTS_INSERT_SETTINGS: ClickHouseSettings = {
  max_memory_usage: String(TACHO_EVENTS_INSERT_MAX_MEMORY_BYTES),
  memory_overcommit_ratio_denominator: "0",
  memory_overcommit_ratio_denominator_for_user: "0",
};

/**
 * Append events. No-ops on an empty array, so an empty batch costs neither a
 * tenant-scope assertion nor a round-trip.
 */
export async function insertTachoEvents(
  inserts: readonly TachoEventInsert[],
): Promise<void> {
  if (inserts.length === 0) return;
  const receivedAt = new Date().toISOString();
  await chInsert(
    TACHO_EVENTS_TABLE,
    inserts.map((insert) => tachoEventRow(insert, receivedAt)),
    TACHO_EVENTS_INSERT_SETTINGS,
  );
}

// ── The read seam ────────────────────────────────────────────────────────────

/** One wrapped-agent frame as the Run page reads it (ADR-058, G6). */
export interface TachoFrameRow {
  seq: number;
  ts: string;
  /** The envelope's ULID. */
  eventId: string;
  kind: string;
  /** The chain link to the frame before (spec §8.3). */
  prevHash: string;
  hash: string;
  /** Empty when the frame carried no content. */
  contentDigest: string;
  /** Empty when no body was retained. */
  bytesRef: string;
  /** The envelope's `content.redactions`, as the JSON text the row holds. */
  redactions: string;
  /** The typed body as JSON text. */
  body: string;
  source?: string;
  fidelity?: string;
  attrs?: Record<string, string>;
  toolName: string;
  toolStatus: string;
  toolUseId: string;
  model: string;
  provider: string;
  policyDecision: string;
  /** Null when the frame carried no cost record. */
  costUsdMicros: number | null;
  turnSeq: number | null;
  /** Milliseconds to the provider's first token; null when it was not timed. */
  ttftMs?: number | null;
  /** The provider call's wall time; null when it was not timed. */
  apiDurationMs?: number | null;
  /** The reasoning effort the harness ran a model call at; empty when unrecorded. */
  effort?: string;
  /**
   * The chain the frame was recorded on, and where that chain sits in the
   * run. Set only by {@link selectTachoSubagentEvents}, which reads frames
   * from more than one chain; a read of one session's chain leaves them unset.
   */
  sessionUuid?: string;
  rootSessionUuid?: string;
  /** The chain that spawned this one; null on the run's own chain. */
  parentSessionUuid?: string | null;
  /** The harness's id for the subagent; empty on the run's own chain. */
  subagentId?: string;
  subagentType?: string;
  /** The parent's tool call that spawned the subagent; empty when none was recorded. */
  spawnToolUseId?: string;
  spawnDepth?: number;
}

interface RawTachoFrameRow {
  seq: string | number;
  ts: string;
  event_id: string;
  kind: string;
  prev_hash: string;
  hash: string;
  content_digest: string;
  bytes_ref: string;
  redactions: string;
  body: string;
  source?: string;
  fidelity?: string;
  attrs?: Record<string, string>;
  tool_name: string;
  tool_status: string;
  tool_use_id: string;
  model: string;
  provider: string;
  policy_decision: string;
  cost_usd_micros: string | number | null;
  turn_seq: string | number | null;
  ttft_ms: string | number | null;
  api_duration_ms: string | number | null;
  effort?: string;
}

interface RawTachoChainFrameRow extends RawTachoFrameRow {
  session_uuid: string;
  root_session_uuid: string;
  parent_session_uuid: string | null;
  subagent_id: string;
  subagent_type: string;
  spawn_tool_use_id: string;
  spawn_depth: string | number;
}

/** The frame columns every read of `tacho_events` projects, in one place. */
const FRAME_COLUMNS = `
        seq, toString(ts) AS ts, event_id, kind, prev_hash, hash, content_digest, bytes_ref,
        redactions, body, source, fidelity, attrs, tool_name, tool_status, tool_use_id, model, provider,
        policy_decision, cost_usd_micros, turn_seq, ttft_ms, api_duration_ms, effort`;

/**
 * A wrapped session's frames past `afterSeq`, in sequence order. The table is
 * a ReplacingMergeTree keyed on (org, workspace, session, seq); `FINAL`
 * collapses a redelivered row so a sequence appears once. Tenant-filtered by
 * the ambient scope through chSelect.
 */
/** A nullable ClickHouse count as a number, or null. */
function nullableCount(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function selectTachoEvents(args: {
  sessionUuid: string;
  afterSeq: number;
  /**
   * The last seq to read. Give it whenever the caller knows it: under `FINAL`
   * a read with no upper bound scans the chain from `afterSeq` to its end
   * whatever `limit` says. On a 240,000-frame chain, 500 frames past seq
   * 100,000 read 155,000 rows unbounded and 5,000 bounded.
   */
  throughSeq?: number;
  limit: number;
}): Promise<TachoFrameRow[]> {
  const res = await chSelect<RawTachoFrameRow>({
    query: `
      SELECT${FRAME_COLUMNS}
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
        AND seq > {afterSeq:Int64}
        ${args.throughSeq === undefined ? "" : "AND seq <= {throughSeq:Int64}"}
      ORDER BY seq ASC
      LIMIT {limit:UInt32}
    `,
    params: {
      sessionUuid: args.sessionUuid,
      afterSeq: args.afterSeq,
      ...(args.throughSeq === undefined ? {} : { throughSeq: args.throughSeq }),
      limit: args.limit,
    },
  });
  return res.data.map(frameRowOf);
}

/** A raw `tacho_events` read as the Run page's frame row. */
function frameRowOf(r: RawTachoFrameRow): TachoFrameRow {
  return {
    seq: Number(r.seq),
    ts: r.ts,
    eventId: r.event_id,
    kind: r.kind,
    prevHash: r.prev_hash,
    hash: r.hash,
    contentDigest: r.content_digest,
    bytesRef: r.bytes_ref,
    redactions: r.redactions,
    body: r.body,
    source: r.source,
    fidelity: r.fidelity,
    attrs: r.attrs,
    toolName: r.tool_name,
    toolStatus: r.tool_status,
    toolUseId: r.tool_use_id,
    model: r.model,
    provider: r.provider,
    policyDecision: r.policy_decision,
    costUsdMicros:
      r.cost_usd_micros === null || r.cost_usd_micros === undefined
        ? null
        : Number(r.cost_usd_micros),
    turnSeq:
      r.turn_seq === null || r.turn_seq === undefined
        ? null
        : Number(r.turn_seq),
    // What the host timed about the model call. The recorded stream carries
    // no clock, so a reassembly's time to first token comes from here.
    ttftMs: nullableCount(r.ttft_ms),
    apiDurationMs: nullableCount(r.api_duration_ms),
    // The reasoning effort the harness ran the call at; empty when unrecorded.
    effort: r.effort ?? "",
  };
}

/** Where a read of a run's subagent chains resumes: the last (session, seq) read. */
export interface TachoChainPosition {
  sessionUuid: string;
  seq: number;
}

/**
 * The frames of every subagent chain under a root session, in (session, seq)
 * order, strictly after `after`, at most `limit`.
 *
 * A subagent records on its own chain (its own `session_uuid`, dense `seq`
 * from 0), with `root_session_uuid` naming the run it belongs to. The run's
 * cost already counts those chains (`cost-frames.ts` reads on the root), so a
 * reader of the run's frames reads them too, and this is that read. Each row
 * carries its chain's identity so the caller can put the chain where it was
 * spawned. `FINAL` like the single-chain read, so a redelivered row appears
 * once. Tenant-filtered by the ambient scope through chSelect.
 */
export async function selectTachoSubagentEvents(args: {
  rootSessionUuid: string;
  /**
   * The subagent chains to read, when the caller has listed them (from
   * `tacho.sessions`). The list puts `session_uuid` in the primary key's
   * range, so ClickHouse reads those chains alone. Without it the read filters
   * on `root_session_uuid`, which no index covers, and scans every chain in
   * the workspace: 855,000 rows for 500 frames on the benchmark table.
   */
  sessionUuids?: readonly string[];
  after: TachoChainPosition | null;
  limit: number;
}): Promise<TachoFrameRow[]> {
  const res = await chSelect<RawTachoChainFrameRow>({
    query: `
      SELECT${FRAME_COLUMNS},
        session_uuid, root_session_uuid, parent_session_uuid, subagent_id,
        subagent_type, spawn_tool_use_id, spawn_depth
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        ${
          args.sessionUuids === undefined
            ? ""
            : "AND session_uuid IN {sessionUuids:Array(UUID)}"
        }
        AND root_session_uuid = {rootSessionUuid:UUID}
        AND session_uuid != {rootSessionUuid:UUID}
        ${
          args.after === null
            ? ""
            : "AND (session_uuid, seq) > ({afterSession:UUID}, {afterSeq:UInt64})"
        }
      ORDER BY session_uuid ASC, seq ASC
      LIMIT {limit:UInt32}
    `,
    params: {
      rootSessionUuid: args.rootSessionUuid,
      ...(args.sessionUuids === undefined
        ? {}
        : { sessionUuids: args.sessionUuids }),
      ...(args.after === null
        ? {}
        : { afterSession: args.after.sessionUuid, afterSeq: args.after.seq }),
      limit: args.limit,
    },
  });
  return res.data.map((r) => ({
    ...frameRowOf(r),
    sessionUuid: r.session_uuid,
    rootSessionUuid: r.root_session_uuid,
    parentSessionUuid: r.parent_session_uuid ?? null,
    subagentId: r.subagent_id ?? "",
    subagentType: r.subagent_type ?? "",
    spawnToolUseId: r.spawn_tool_use_id ?? "",
    spawnDepth: Number(r.spawn_depth ?? 0),
  }));
}

/** The projected columns beside the envelope that a frame row reads. */
const FRAME_BODY_COLUMNS = [
  "tool_name",
  "tool_status",
  "tool_use_id",
  "model",
  "provider",
  "policy_decision",
  "cost_usd_micros",
  "ttft_ms",
  "api_duration_ms",
] as const;

/** One stored event: the frame row, and the envelope columns it came from. */
export interface TachoEventRecord {
  frame: TachoFrameRow;
  /**
   * Every envelope column of the row, as ClickHouse reads it back, with
   * `ts` as `toString(ts)`. `bytes_ref` is left out: the stored column is
   * where the control plane kept the body, not the event's own member, so it
   * would mislead `unflattenEvent`. The frame row carries it.
   */
  envelope: Record<string, unknown>;
}

/**
 * A wrapped session's events past `afterSeq` with every envelope column, for
 * the run export, which rebuilds each sealed event with `unflattenEvent`. The
 * same fence and ordering as `selectTachoEvents`.
 */
export async function selectTachoEventRecords(args: {
  sessionUuid: string;
  afterSeq: number;
  limit: number;
}): Promise<TachoEventRecord[]> {
  const columns = [...ENVELOPE_COLUMNS, ...FRAME_BODY_COLUMNS].map((name) =>
    name === "ts" ? "toString(ts) AS ts" : `\`${name}\``,
  );
  const res = await chSelect<RawTachoFrameRow & Record<string, unknown>>({
    query: `
      SELECT ${columns.join(", ")}
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
        AND seq > {afterSeq:Int64}
      ORDER BY seq ASC
      LIMIT {limit:UInt32}
    `,
    params: {
      sessionUuid: args.sessionUuid,
      afterSeq: args.afterSeq,
      limit: args.limit,
    },
  });
  return res.data.map((r) => {
    const envelope: Record<string, unknown> = {};
    for (const name of ENVELOPE_COLUMNS) {
      if (name !== "bytes_ref") envelope[name] = r[name];
    }
    return { frame: frameRowOf(r), envelope };
  });
}

/**
 * The stored hash and body reference of each of `seqs` on one chain, keyed
 * by seq. A seq with no stored row is absent from the map.
 *
 * The intake asks this of every event a batch re-sends below the recorded
 * head: a re-sent seq whose stored hash differs is a different frame
 * claiming a position the chain already holds, and it is refused rather than
 * written over the stored one. `FINAL`, so the answer is the row a reader
 * sees.
 */
export async function selectTachoStoredFrames(args: {
  sessionUuid: string;
  seqs: readonly number[];
}): Promise<
  Map<number, { hash: string; contentDigest: string; bytesRef: string }>
> {
  const out = new Map<
    number,
    { hash: string; contentDigest: string; bytesRef: string }
  >();
  if (args.seqs.length === 0) return out;
  const res = await chSelect<{
    seq: string | number;
    hash: string;
    content_digest: string;
    bytes_ref: string;
  }>({
    query: `
      SELECT seq, hash, content_digest, bytes_ref
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
        AND seq IN {seqs:Array(UInt64)}
    `,
    params: { sessionUuid: args.sessionUuid, seqs: [...args.seqs] },
  });
  for (const r of res.data) {
    out.set(Number(r.seq), {
      hash: r.hash,
      contentDigest: r.content_digest,
      bytesRef: r.bytes_ref,
    });
  }
  return out;
}

/**
 * An agent's observed model spend on one UTC day, per host (ADR-160).
 *
 * Summed from the `llm_call` frames the loopback model proxy sealed and
 * priced (`fidelity = 'proxy'`, `source = 'collector'`,
 * `oxagen.metering = observed`), the same calls ingest counts as usage. The
 * day is read from each frame's own `ts`, never from `received_at`, so a
 * frame shipped after midnight still counts toward the day it was recorded
 * in, which is the day the host charged it to. `FINAL` collapses a
 * redelivered frame so it is counted once.
 *
 * The table partitions by the month of `received_at` (#4297), so the `ts`
 * filter alone reads every month the workspace holds. The `received_at`
 * bound keeps the read to the months around the day. It does not change
 * which frames count: a frame stamped on the day reached the control plane
 * no earlier than the day's start less the host clock's lead, and the bound
 * allows a lead of one day. A host whose clock runs further ahead stamps its
 * frames with a day that has not begun.
 *
 * `hostEnrollmentIds` are the agent's hosts, every status included: a host
 * revoked at noon still spent its morning. Returns micro-USD by host
 * enrollment id; a host with no priced call that day is absent.
 */
export async function selectAgentDaySpend(args: {
  day: string;
  hostEnrollmentIds: readonly string[];
}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (args.hostEnrollmentIds.length === 0) return out;
  const start = `${args.day} 00:00:00.000`;
  const res = await chSelect<{
    host_enrollment_id: string;
    micros: string | number;
  }>({
    query: `
      SELECT host_enrollment_id, sum(cost_usd_micros) AS micros
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND host_enrollment_id IN {hosts:Array(String)}
        AND kind = 'llm_call'
        AND source = 'collector'
        AND fidelity = 'proxy'
        AND attrs[{meteringAttr:String}] = {metered:String}
        AND cost_usd_micros IS NOT NULL
        AND ts >= toDateTime64({start:String}, 3, 'UTC')
        AND ts < toDateTime64({start:String}, 3, 'UTC') + INTERVAL 1 DAY
        AND received_at >= toDateTime64({start:String}, 3, 'UTC') - INTERVAL 1 DAY
      GROUP BY host_enrollment_id
    `,
    params: {
      hosts: [...args.hostEnrollmentIds],
      meteringAttr: TACHO_METERING_ATTR,
      metered: TACHO_METERING_OBSERVED,
      start,
    },
  });
  for (const row of res.data) {
    const micros = Number(row.micros);
    if (Number.isFinite(micros) && micros > 0)
      out.set(row.host_enrollment_id, micros);
  }
  return out;
}
