/**
 * @oxagen/replay — time-travel replay for ADR-023 fleet sessions (ADR-028).
 *
 * A deterministic sidecar record (full tool I/O, per-turn model history,
 * filesystem layers) plus the operations it enables: integrity-verified
 * replay, turn bisection, resume-from-turn, and failure→eval distillation.
 */
export { sha256Hex, stableStringify, safeStableStringify } from "./hash.js";
export {
  RECORD_SCHEMA_VERSION,
  MAX_TOOL_BLOB_BYTES,
  MAX_HISTORY_BLOB_BYTES,
  MAX_LAYER_FILE_BYTES,
  recordUsageSchema,
  layerFileSchema,
  replayRecordSchema,
  serializeReplayRecord,
  parseReplayRecordLine,
  truncatedBlobSchema,
  isTruncatedBlob,
  type RecordUsage,
  type LayerFile,
  type ReplayRecord,
  type ReplayRecordType,
  type ReplayRecordInput,
  type TruncatedBlob,
} from "./records.js";
export {
  RECORD_DIR_NAME,
  RecordStore,
  openRecordStore,
  type RecordWriter,
  type PutBlobResult,
} from "./store.js";
export {
  SessionRecorder,
  createSessionRecorder,
  type ExecPort,
  type SessionRecorderOptions,
  type RecorderStartArgs,
  type RecorderTurnEndArgs,
} from "./recorder.js";
export {
  readRun,
  verifyRun,
  reconstructHistory,
  restoreFsAtTurn,
  removeWorktree,
  type ReplayRun,
  type ReplayTurn,
  type VerifyResult,
  type RestoreResult,
} from "./restore.js";
export { bisectTurns, type BisectProbe, type BisectResult } from "./bisect.js";
export {
  DISTILL_DATASET_SLUG,
  distillReasonSchema,
  distilledEvalItemSchema,
  distillEvalItem,
  type DistillReason,
  type DistilledEvalItem,
  type DistillSource,
} from "./distill.js";
