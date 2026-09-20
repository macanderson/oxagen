/**
 * Frame bodies and the seal's replay evidence for the run ledger
 * (Mission Control spec §8.2, §8.3, §8.4, §13; ADR-058).
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
  isContentBearingFrame,
  type JsonValue,
  type Redaction,
  type GradeEnforcementTier,
  type ReplayGrade,
  digestBytes,
  redactBytes,
} from "@oxagen/tacho";
import {
  isContentClassRetained,
  stepKindOfEventType,
} from "./event-payload-registry";
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
  /**
   * Where the body's REASSEMBLY goes: the message a recorded model stream
   * folded into, derived once at write (`content-blocks.ts`) and stored
   * beside the wire so no viewer ever folds it again.
   *
   * Optional, because it is derived and not evidence. A store without one
   * records the run exactly as before, and a reader folds the wire itself.
   */
  putAssembly?(input: {
    orgId: string;
    workspaceId: string;
    runId: string;
    /** The body reference the assembly belongs to. */
    bodyRef: string;
    bytes: Uint8Array;
  }): Promise<void>;
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

/**
 * Both spellings of each call event, from the registry: the ledger's own
 * `model.call_completed` / `tool.call_completed` and the in-app assistant's
 * `model.engine_call_completed` / `tool.engine_call_completed`. The rollup
 * and the gaps below counted only the first pair, so every run the assistant
 * recorded sealed with `modelCalls: 0`, `toolCalls: 0` and no `tool_bodies`
 * gap however many calls it made.
 *
 * The registry is asked rather than a list kept here, so a new call event is
 * counted the moment it declares its step. The `*_started` write-ahead
 * intentions declare none: a started event with no matching completion is a
 * dangling intention, and counting it would report a call the record does not
 * claim happened.
 */
function isToolCallEvent(eventType: string): boolean {
  return stepKindOfEventType(eventType) === "tool_call";
}

function isModelCallEvent(eventType: string): boolean {
  return stepKindOfEventType(eventType) === "model_call";
}

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
    if (isToolCallEvent(row.event_type)) toolCalls += 1;
    if (!isModelCallEvent(row.event_type)) continue;
    modelCalls += 1;
    const payload = row.payload_inline;
    const turn =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["turn_index"]
        : undefined;
    // A model call whose payload carries no turn index — an encrypted one, or
    // an engine call, whose schema has no such field — hides the turn count.
    // `turns: null` is "not recorded"; a number here would be a count of the
    // calls that happened to be legible, presented as the run's turns.
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
 * - `body_missing` when a frame carried content and no body was retained: a
 *   content-bearing frame (`isContentBearingFrame`) with no body reference,
 *   whether or not the producer handed the ledger bytes to digest, or any
 *   other frame whose digest was recorded and whose bytes were not;
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
    const carriesContent =
      row.body_digest !== null || isContentBearingFrame(row.event_type);
    if (carriesContent && row.body_ref === null) {
      gaps.add(
        input.policy.mode === "digest_only" ? "digest_only" : "body_missing",
      );
    }
    if (isToolCallEvent(row.event_type)) {
      toolCalls += 1;
      if (row.body_ref !== null) toolBodies += 1;
    }
  }
  if (toolCalls > 0 && toolBodies === 0) gaps.add("tool_bodies");
  if (input.terminalStatus === "abandoned") gaps.add("unobserved_tail");
  return [...gaps];
}

/** The rows whose body the store retained. */
export function countRetainedBodies(rows: readonly SealedFrameRow[]): number {
  return rows.filter((row) => row.body_ref !== null).length;
}

/**
 * Where a sealed attempt's model calls were observed, read from the rows.
 *
 * A model call an engine Oxagen did not host submits as evidence is
 * client-attested (`model.call_completed`): the `harness` tier. A model call
 * the in-app engine made through Oxagen's own gateway is recorded as the
 * engine's own call (`model.engine_call_completed`), which means the request
 * and the response passed through the seam that wrote the frame — the
 * `gateway` tier, and the only tier §8.4 lets a recording reach `fork` from.
 *
 * A run with both was partly attested and grades at the weaker tier. A run with
 * no model call at all is `harness`: nothing observed anything at the gateway,
 * and inferring the stronger tier from an absence would raise a grade the
 * record does not support.
 */
export function ledgerEnforcementTier(
  rows: readonly SealedFrameRow[],
): GradeEnforcementTier {
  let gatewayObserved = false;
  for (const row of rows) {
    // A submitted receipt: evidence from an engine Oxagen did not host.
    if (row.event_type === "model.call_completed") return "harness";
    if (row.event_type === "model.engine_call_completed")
      gatewayObserved = true;
  }
  return gatewayObserved ? "gateway" : "harness";
}

/**
 * The grade a sealed attempt records (spec §8.4), from the gaps its rows show,
 * the bodies it retained and the tier its model calls were observed at.
 *
 * `retry` is not reachable here: it needs a harness that reports a reproducible
 * run, and no producer reports that in this revision. Nothing infers it.
 */
export function gradeSealedAttempt(
  gaps: readonly string[],
  retainedBodies: number,
  enforcementTier: GradeEnforcementTier = "harness",
): ReplayGrade {
  return computeReplayGrade({
    gaps,
    enforcementTier,
    harnessReproducible: false,
    retainedBodies,
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
