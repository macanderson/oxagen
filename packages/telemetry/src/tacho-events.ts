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
import { flattenEvent, type TachoEvent } from "@oxagen/tacho";
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
}

/**
 * A wrapped session's frames past `afterSeq`, in sequence order. The table is
 * a ReplacingMergeTree keyed on (org, workspace, session, seq); `FINAL`
 * collapses a redelivered row so a sequence appears once. Tenant-filtered by
 * the ambient scope through chSelect.
 */
/** A nullable ClickHouse count as a number, or null. */
function nullableCount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function selectTachoEvents(args: {
  sessionUuid: string;
  afterSeq: number;
  limit: number;
}): Promise<TachoFrameRow[]> {
  const res = await chSelect<RawTachoFrameRow>({
    query: `
      SELECT
        seq, toString(ts) AS ts, event_id, kind, prev_hash, hash, content_digest, bytes_ref,
        redactions, body, tool_name, tool_status, tool_use_id, model, provider,
        policy_decision, cost_usd_micros, turn_seq, ttft_ms, api_duration_ms
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
  return res.data.map((r) => ({
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
  }));
}
