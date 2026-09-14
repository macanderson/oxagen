/**
 * Frame bodies and the seal's replay evidence for the run ledger
 * (Mission Control spec §8.2, §8.3, §8.4, §13; ADR-057).
 *
 * A producer may hand the ledger the content a frame is about (the prompt,
 * the model response, the tool input and output) next to the frame's
 * receipt payload. The ledger redacts it, digests the redacted bytes, and,
 * when the run's pinned retention policy authorises the frame's content
 * class, writes the bytes through the injected body store and records the
 * reference on the row. A policy that keeps digests alone still records the
 * digest, so the chain stays verifiable against a body nobody retained.
 *
 * At seal the ledger derives the completeness gaps from the durable rows,
 * grades them, and writes the archive segment and the Merkle root next to the
 * seal. Everything here is pure: the store calls it inside its transactions
 * and the tests drive it without a database.
 */
import {
  type ArchiveFrame,
  type CompletenessGapKind,
  computeReplayGrade,
  type JsonValue,
  type Redaction,
  type ReplayGrade,
  digestBytes,
  redactBytes,
} from "@oxagen/tacho";
import { isContentClassRetained } from "./event-payload-registry";
import type { AttemptTerminalStatus } from "./run-store";

/** The bytes a producer hands the ledger with a frame. */
export interface AttemptEventBodyInput {
  contentType: string;
  bytes: Uint8Array;
}

/** A body after redaction, ready to be written or digested only. */
export interface PreparedFrameBody {
  contentType: string;
  /** The redacted bytes: what a reader gets back, and what the digest names. */
  bytes: Uint8Array;
  digest: string;
  byteLength: number;
  redactions: Redaction[];
}

export function prepareFrameBody(
  input: AttemptEventBodyInput,
): PreparedFrameBody {
  const redacted = redactBytes(input.bytes);
  return {
    contentType: input.contentType,
    bytes: redacted.bytes,
    digest: digestBytes(redacted.bytes),
    byteLength: redacted.bytes.byteLength,
    redactions: redacted.redactions,
  };
}

/** The fidelity a frame row records (`agent_run_events.fidelity`). */
export type FrameFidelity = "full" | "digest_only";

/** The body columns of one event row. */
export interface FrameBodyColumns {
  bodyRef: string | null;
  bodyDigest: string | null;
  bodyBytes: number | null;
  redactions: Redaction[] | null;
  fidelity: FrameFidelity;
}

export const NO_BODY: FrameBodyColumns = {
  bodyRef: null,
  bodyDigest: null,
  bodyBytes: null,
  redactions: null,
  fidelity: "digest_only",
};

/** The run's pinned retention policy, as the attempt lock projects it. */
export interface RetentionPolicyBinding {
  mode: string;
  retainedContentClasses: readonly string[];
}

/**
 * Does the pinned policy authorise retaining this frame's bytes? A
 * `digest_only` policy retains nothing whatever its classes say; any other
 * mode retains the classes it lists.
 */
export function bodyRetainedByPolicy(
  eventType: string,
  policy: RetentionPolicyBinding,
): boolean {
  if (policy.mode === "digest_only") return false;
  return isContentClassRetained(eventType, policy.retainedContentClasses);
}

/** Where a retained body is written. Injected: the ledger never opens a bucket. */
export interface RunBodyStore {
  put(input: {
    orgId: string;
    workspaceId: string;
    runId: string;
    digest: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
}

/** Where a seal's archive segment is written once, and read back from. */
export interface RunArchiveStore {
  putSegment(input: {
    orgId: string;
    workspaceId: string;
    runId: string;
    attemptId: string;
    digest: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** The segment bytes a seal's `archive_segment_ref` names. */
  getSegment(ref: string): Promise<Uint8Array>;
}

/** The body columns for a body the policy keeps as a digest alone. */
export function digestOnlyColumns(body: PreparedFrameBody): FrameBodyColumns {
  return {
    bodyRef: null,
    bodyDigest: body.digest,
    bodyBytes: body.byteLength,
    redactions: body.redactions,
    fidelity: "digest_only",
  };
}

/** The body columns for a body the store retained under `ref`. */
export function retainedColumns(
  body: PreparedFrameBody,
  ref: string,
): FrameBodyColumns {
  return {
    bodyRef: ref,
    bodyDigest: body.digest,
    bodyBytes: body.byteLength,
    redactions: body.redactions,
    fidelity: "full",
  };
}

// ── Seal: gaps, grade, segment ──────────────────────────────────────────────

/** The durable event row as the seal reads it back. */
export interface SealedFrameRow {
  id: string;
  attempt_seq: number | string;
  run_seq: number | string;
  event_schema_version: string;
  event_type: string;
  stage: string;
  payload_digest: string;
  event_digest: string;
  payload_inline: unknown | null;
  encrypted_payload_ref: string | null;
  observed_at: string | Date;
  created_at: string | Date;
  body_ref: string | null;
  body_digest: string | null;
  body_bytes: number | string | null;
  redactions: unknown | null;
  fidelity: string;
}

const TOOL_CALL_EVENT = "tool.call_completed";
const MODEL_CALL_EVENT = "model.call_completed";

/**
 * The seal's rollup (spec §13.3): what the run keeps of its counts once
 * compaction has removed the hot frames. A step is one model call or one
 * tool call; a turn is a distinct `turn_index` among model calls, which
 * travels only in an inline payload, so one encrypted model call hides the
 * turn count and `turns` is null.
 */
export interface SealRollup {
  modelCalls: number;
  toolCalls: number;
  turns: number | null;
}

export function deriveSealRollup(rows: readonly SealedFrameRow[]): SealRollup {
  let modelCalls = 0;
  let toolCalls = 0;
  let opaque = false;
  const turns = new Set<string>();
  for (const row of rows) {
    if (row.event_type === TOOL_CALL_EVENT) toolCalls += 1;
    if (row.event_type !== MODEL_CALL_EVENT) continue;
    modelCalls += 1;
    const payload = row.payload_inline;
    const turn =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["turn_index"]
        : undefined;
    if (turn === undefined || turn === null) opaque = true;
    else turns.add(String(turn));
  }
  return { modelCalls, toolCalls, turns: opaque ? null : turns.size };
}

/**
 * The completeness gaps a sealed attempt carries, from its rows and its
 * terminal status:
 *
 * - `digest_only` when the pinned policy kept digests alone;
 * - `body_missing` when a frame carried content the policy did not keep;
 * - `tool_bodies` when tool calls happened and none kept its result body;
 * - `unobserved_tail` when the attempt was abandoned: no producer observed
 *   its end.
 *
 * The ledger refuses sequence gaps and digest conflicts at append, so
 * `chain_break` and `telemetry_gap` cannot arise here.
 */
export function deriveCompletenessGaps(input: {
  rows: readonly SealedFrameRow[];
  policy: RetentionPolicyBinding;
  terminalStatus: AttemptTerminalStatus;
}): CompletenessGapKind[] {
  const gaps = new Set<CompletenessGapKind>();
  if (input.policy.mode === "digest_only") gaps.add("digest_only");
  let toolCalls = 0;
  let toolBodies = 0;
  for (const row of input.rows) {
    if (row.body_digest !== null && row.body_ref === null) {
      gaps.add(
        input.policy.mode === "digest_only" ? "digest_only" : "body_missing",
      );
    }
    if (row.event_type === TOOL_CALL_EVENT) {
      toolCalls += 1;
      if (row.body_ref !== null) toolBodies += 1;
    }
  }
  if (toolCalls > 0 && toolBodies === 0) gaps.add("tool_bodies");
  if (input.terminalStatus === "abandoned") gaps.add("unobserved_tail");
  return [...gaps];
}

/**
 * A ledger run's evidence is submitted by an engine Oxagen did not host
 * (ADR-043), so its frames are client-attested: the `harness` tier, which
 * caps the grade at `view`. A gateway-observed ledger run and a harness that
 * reports a reproducible run are both seams a later lane opens; nothing here
 * infers either.
 */
export function gradeSealedAttempt(gaps: readonly string[]): ReplayGrade {
  return computeReplayGrade({
    gaps,
    enforcementTier: "harness",
    harnessReproducible: false,
  });
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : value;

/**
 * One durable row as the archive segment writes it: everything but bytes.
 * `readArchiveFrame` is its inverse; a compacted attempt is read from these.
 */
export function archiveFrameOf(row: SealedFrameRow): ArchiveFrame {
  const envelope: JsonValue = {
    event_id: row.id,
    attempt_seq: Number(row.attempt_seq),
    run_seq: String(row.run_seq),
    event_schema_version: row.event_schema_version,
    event_type: row.event_type,
    stage: row.stage,
    payload_digest: row.payload_digest,
    event_digest: row.event_digest,
    payload_inline: (row.payload_inline ?? null) as JsonValue,
    encrypted_payload_ref: row.encrypted_payload_ref,
    observed_at: iso(row.observed_at),
    recorded_at: iso(row.created_at),
    content: {
      digest: row.body_digest,
      bytes_ref: row.body_ref,
      bytes: row.body_bytes === null ? null : Number(row.body_bytes),
      redactions: (row.redactions ?? []) as JsonValue,
      fidelity: row.fidelity,
    },
  };
  return { digest: row.event_digest as ArchiveFrame["digest"], envelope };
}

/**
 * The envelope back into the row shape, or null for a line that is not one
 * of ours. Every field the segment wrote is read back; nothing is defaulted.
 */
export function readArchiveFrame(envelope: JsonValue): SealedFrameRow | null {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  )
    return null;
  const e = envelope as Record<string, JsonValue | undefined>;
  const content = e["content"];
  if (typeof content !== "object" || content === null || Array.isArray(content))
    return null;
  const c = content as Record<string, JsonValue | undefined>;
  const str = (v: JsonValue | undefined): string | null =>
    typeof v === "string" ? v : null;
  const id = str(e["event_id"]);
  const runSeq = str(e["run_seq"]);
  const eventType = str(e["event_type"]);
  const stage = str(e["stage"]);
  const schemaVersion = str(e["event_schema_version"]);
  const payloadDigest = str(e["payload_digest"]);
  const eventDigest = str(e["event_digest"]);
  const observedAt = str(e["observed_at"]);
  const recordedAt = str(e["recorded_at"]);
  const fidelity = str(c["fidelity"]);
  if (
    id === null ||
    runSeq === null ||
    eventType === null ||
    stage === null ||
    schemaVersion === null ||
    payloadDigest === null ||
    eventDigest === null ||
    observedAt === null ||
    recordedAt === null ||
    fidelity === null ||
    typeof e["attempt_seq"] !== "number"
  )
    return null;
  return {
    id,
    attempt_seq: e["attempt_seq"],
    run_seq: runSeq,
    event_schema_version: schemaVersion,
    event_type: eventType,
    stage,
    payload_digest: payloadDigest,
    event_digest: eventDigest,
    payload_inline: e["payload_inline"] ?? null,
    encrypted_payload_ref: str(e["encrypted_payload_ref"]),
    observed_at: observedAt,
    created_at: recordedAt,
    body_ref: str(c["bytes_ref"]),
    body_digest: str(c["digest"]),
    body_bytes: typeof c["bytes"] === "number" ? c["bytes"] : null,
    redactions: c["redactions"] ?? null,
    fidelity,
  };
}
