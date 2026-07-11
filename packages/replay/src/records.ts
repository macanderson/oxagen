/**
 * The record-v1 envelope (ADR-028) — the deterministic sidecar of an ADR-023
 * fleet session. Where the session's `events.ndjson` is bounded for tailing
 * and rendering, `record/record.ndjson` is complete for time travel: full
 * tool I/O, full per-turn model history, and filesystem layers, with large
 * payloads content-addressed in `record/blobs/<sha256>`.
 *
 * Same evolution discipline as the ADR-023 envelope: additive-only within
 * `rv: 1` — new record types and new optional fields are fine; renaming,
 * removing, or retyping anything bumps `rv` and is a migration. The golden
 * test in `records.test.ts` pins one sample of every type.
 */
import { z } from "zod";

/** Bump ONLY on a breaking record-schema change (see module doc). */
export const RECORD_SCHEMA_VERSION = 1 as const;

/** Per-blob size ceiling for tool I/O payloads; larger payloads truncate. */
export const MAX_TOOL_BLOB_BYTES = 2 * 1024 * 1024;
/** Per-blob ceiling for turn history — generous, resume refuses truncated history. */
export const MAX_HISTORY_BLOB_BYTES = 32 * 1024 * 1024;
/** Per-file ceiling for fs-layer snapshots; larger files are marked skipped. */
export const MAX_LAYER_FILE_BYTES = 8 * 1024 * 1024;

/** Cumulative token/cost usage for one turn (mirrors the envelope's shape). */
export const recordUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type RecordUsage = z.infer<typeof recordUsageSchema>;

/**
 * One file in a filesystem layer: the file's full post-state content in the
 * blob store, or a tombstone (`ref: null`) for a deletion. `isSkipped` marks a
 * file whose content could not be captured (over the size ceiling or
 * unreadable) — restores report these instead of silently missing them.
 */
export const layerFileSchema = z.object({
  path: z.string().min(1),
  ref: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  isSkipped: z.boolean().optional(),
});
export type LayerFile = z.infer<typeof layerFileSchema>;

const base = {
  rv: z.literal(RECORD_SCHEMA_VERSION),
  sid: z.string().min(1),
  seq: z.number().int().positive(),
  ts: z.number().int().positive(),
};

export const replayRecordSchema = z.discriminatedUnion("t", [
  // Run identity: what ran, where, and from which git base.
  z.object({
    ...base,
    t: z.literal("run.meta"),
    cwd: z.string().min(1),
    prompt: z.string(),
    model: z.string().optional(),
    agent: z.string().optional(),
    cliVersion: z.string().optional(),
    /** Git HEAD sha the run started from; layers apply on top of it. */
    gitHead: z.string().optional(),
  }),
  // Filesystem layer AFTER `turn` settled. Turn 0 is the baseline: the
  // pre-run content of every file that was dirty when the session started.
  z.object({
    ...base,
    t: z.literal("fs.layer"),
    turn: z.number().int().nonnegative(),
    files: z.array(layerFileSchema),
  }),
  z.object({
    ...base,
    t: z.literal("turn.start"),
    turn: z.number().int().positive(),
    prompt: z.string(),
  }),
  // One tool execution, FULL input and output (blob-referenced, uncapped by
  // the envelope's 2 KB wire limit; capped only by MAX_TOOL_BLOB_BYTES with
  // an explicit truncation marker).
  z.object({
    ...base,
    t: z.literal("tool.io"),
    turn: z.number().int().positive(),
    /** 1-based tool-call index within the whole session (stable identity). */
    idx: z.number().int().positive(),
    name: z.string().min(1),
    callId: z.string().optional(),
    inputRef: z.string(),
    outputRef: z.string(),
    ok: z.boolean(),
    durationMs: z.number().nonnegative(),
  }),
  // Turn settled: the FULL ModelMessage[] history after this turn — exactly
  // what the model sees entering the next turn, and what a resume seeds from.
  z.object({
    ...base,
    t: z.literal("turn.end"),
    turn: z.number().int().positive(),
    historyRef: z.string(),
    changedFiles: z.array(z.string()),
    steps: z.number().int().nonnegative(),
    stopReason: z.string().optional(),
    usage: recordUsageSchema,
  }),
  // Human verdict on a finished run (appended post-hoc by `fleet feedback`).
  z.object({
    ...base,
    t: z.literal("feedback"),
    verdict: z.enum(["up", "down"]),
    comment: z.string().optional(),
  }),
  // A distilled evals-v1 case was produced from this run.
  z.object({
    ...base,
    t: z.literal("distill"),
    reason: z.enum(["failed", "thumbs_down", "manual"]),
    itemRef: z.string(),
    datasetSlug: z.string().optional(),
    isPushed: z.boolean(),
  }),
]);

export type ReplayRecord = z.infer<typeof replayRecordSchema>;
export type ReplayRecordType = ReplayRecord["t"];

/** A record before the writer stamps `rv`/`sid`/`seq`/`ts`. */
export type ReplayRecordInput = ReplayRecord extends infer R
  ? R extends { t: string }
    ? Omit<R, "rv" | "sid" | "seq" | "ts">
    : never
  : never;

/** One record → one NDJSON line (no trailing newline). */
export function serializeReplayRecord(record: ReplayRecord): string {
  return JSON.stringify(record);
}

/**
 * Parse one NDJSON line. Tolerant like the envelope parser: a torn tail line,
 * a blank, or a foreign object yields `null`, never a throw.
 */
export function parseReplayRecordLine(line: string): ReplayRecord | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = replayRecordSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * The truncation marker stored IN PLACE of an over-ceiling payload. Carries
 * the full content's hash and size so integrity is still checkable and the
 * truncation is explicit, never silent.
 */
export const truncatedBlobSchema = z.object({
  __truncated: z.literal(true),
  bytes: z.number().int().positive(),
  sha256: z.string().length(64),
  head: z.string(),
});
export type TruncatedBlob = z.infer<typeof truncatedBlobSchema>;

/** True when a decoded blob is a truncation marker rather than the payload. */
export function isTruncatedBlob(value: unknown): value is TruncatedBlob {
  return truncatedBlobSchema.safeParse(value).success;
}
