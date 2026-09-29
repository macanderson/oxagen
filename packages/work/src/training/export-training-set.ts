// export-training-set.ts: one workspace's training set, as JSON Lines.
//
// exportTrainingSet is pure. An Inngest function gathers its input and stores the
// object it returns. agent-work-spec.html (Owned models) sets the rules:
//
// - Nothing is exported unless [training] consent is own_model.
// - One done record with a final verdict and TRAINING_LABEL_WINDOW_DAYS behind its
//   merge becomes one training-example/v1 line per stage session.
// - positive: a proven record, not reverted and not reopened within the window.
//   negative: a broken record, or a change reverted or reopened within the window.
//   unlabeled: a record that stayed held. It stays out of the first model.
// - Bodies travel only where the run's retention mode kept them, so a digest_only
//   trace gives no example.
// - The sensitive-data screen runs again on every body in every export, although
//   it already ran before the body was stored.
import type { DoneRecord, DoneVerdict, WorkItemId } from "@oxagen/done-record";
import type { Sha256Digest } from "@oxagen/run-evidence";
import { notBuilt } from "../not-built";
import type {
  JsonObject,
  StageKind,
  TrainingConsent,
  TrainingCorrection,
  TrainingMessage,
} from "../types";

/** A record's label waits this many days after its merge, so a revert or a reopen can land first. */
export const TRAINING_LABEL_WINDOW_DAYS = 30;

/** The first owned model needs this many positive examples in the workspace. */
export const FIRST_MODEL_MIN_POSITIVE = 1000;

/** A run's retention mode, pinned per retention policy version. Only the last two keep bodies. */
export const RETENTION_MODES = ["digest_only", "content_exact", "environment_restore"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

/** One done record with its verdict and what happened after its merge. Every time is RFC 3339. */
export interface TrainingRecord {
  record: DoneRecord;
  /** The record's lock digest. */
  digest: Sha256Digest;
  verdict: DoneVerdict;
  /** When the work merged, or null when it never merged. */
  mergedAt: string | null;
  revertedAt: string | null;
  reopenedAt: string | null;
  /** The triage corrections a person made to the item. */
  corrections: TrainingCorrection[];
}

/** One stage session that built against a record. */
export interface TrainingTrace {
  item: WorkItemId;
  /** The lock digest the session worked against. */
  record: Sha256Digest;
  stage: StageKind;
  retention: RetentionMode;
  messages: TrainingMessage[];
  /** The tool definitions the session received. */
  tools: JsonObject[];
  diff: string;
}

/** The input to exportTrainingSet. */
export interface TrainingSetInput {
  records: readonly TrainingRecord[];
  traces: readonly TrainingTrace[];
  consent: TrainingConsent;
  /** The time to label at. Passed in so the function stays pure. */
  now: string;
}

/** The output of exportTrainingSet. */
export interface TrainingSet {
  /** One training-example/v1 object per line, each line ending in a newline. Empty without consent. */
  jsonl: string;
  counts: {
    /** Every line in jsonl. */
    count: number;
    positive: number;
    negative: number;
    unlabeled: number;
  };
}

/** Build a workspace's training set. Pure. */
export function exportTrainingSet(input: TrainingSetInput): TrainingSet {
  return notBuilt("exportTrainingSet", input);
}
