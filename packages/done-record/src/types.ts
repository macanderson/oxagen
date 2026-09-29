// types.ts: the done record as done-record/v1 defines it, and the names every
// lane uses for its criteria, checks, oracles, states, verdicts, and reasons.
//
// agent-work-spec.html (Done record) is the source. The JSON Schema at
// schemas/done-record.v1.json and these types describe the same file, and
// src/schema.test.ts validates the spec's example against both.
import type { Sha256Digest } from "@oxagen/run-evidence";

/** The value of `schema` in a done record. */
export const DONE_RECORD_SCHEMA = "done-record/v1" as const;

/** The in-toto predicate type of the attestation Oxagen signs when a verdict changes. */
export const DONE_RECORD_PREDICATE_TYPE = "https://oxagen.sh/attestations/done-record/v1" as const;

/** The name of the check Oxagen posts on a pull request with the record's verdict. */
export const DONE_CHECK_NAME = "Oxagen done" as const;

/** The most criteria one record holds. */
export const MAX_CRITERIA = 40;

/** A work item's public id. */
export type WorkItemId = `wi_${string}`;

/** A triage decision's public id. */
export type TriageDecisionId = `tri_${string}`;

/** Which workflow stage owns a criterion, by the tag the stage lists in `owns`. */
export const CRITERION_TAGS = ["code", "test", "docs", "review"] as const;
export type CriterionTag = (typeof CRITERION_TAGS)[number];

/** The six check kinds. There is no seventh (dod-spec.md D8). */
export const CHECK_KINDS = ["run", "file", "diff", "tools", "budget", "human"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** The seconds a run check gets when the record sets no `timeout_s`. */
export const RUN_CHECK_DEFAULT_TIMEOUT_S = 600;

/** The times an agent may try to finish when a budget check sets no `stop_attempts`. */
export const BUDGET_DEFAULT_STOP_ATTEMPTS = 3;

/** A command whose exit code decides the check. */
export interface RunCheck {
  run: string;
  timeout_s?: number;
}

/** A file that must exist, be absent, contain a string, or match a digest. */
export interface FileCheck {
  file: {
    path: string;
    exists?: boolean;
    contains?: string;
    sha256?: Sha256Digest;
  };
}

/** Path globs the change may and may not touch. `allow` defaults to `["**"]`. */
export interface DiffCheck {
  diff: {
    allow?: string[];
    deny?: string[];
  };
}

/** Tools the agent must not call. */
export interface ToolsCheck {
  tools: {
    deny: string[];
  };
}

/** Cost, tool-call, time, and stop-attempt limits for the work. */
export interface BudgetCheck {
  budget: {
    usd?: number;
    tool_calls?: number;
    minutes?: number;
    stop_attempts?: number;
  };
}

/** A person's signature. The value is the handle of the person who signs. */
export interface HumanCheck {
  human: string;
}

export type Check = RunCheck | FileCheck | DiffCheck | ToolsCheck | BudgetCheck | HumanCheck;

/** The fourteen deterministic oracle classes of witness-spec.md. */
export const ORACLE_CLASSES = [
  "example",
  "predicate",
  "invariant",
  "schema",
  "executable",
  "differential",
  "property",
  "replay",
  "policy",
  "budget",
  "provenance",
  "structural",
  "convergence",
  "formal",
] as const;
export type OracleClass = (typeof ORACLE_CLASSES)[number];

/** An oracle the verify stage runs again in a pinned, contained runtime. */
export interface Oracle {
  class: OracleClass;
  /** The file that holds the oracle's evaluator or its expected output. */
  witness?: string;
}

/** One thing that must be true for the work item to be done. */
export interface Criterion {
  /** Lowercase letters, digits, and hyphens, at most 40 characters. */
  id: string;
  text: string;
  tag: CriterionTag;
  check?: Check;
  oracle?: Oracle;
  /** A case that must fail. Lint requires one when the text names a threshold, a boundary, or "only". */
  negative?: string;
}

/** The model route and triage decision that drafted a record. */
export interface DraftedBy {
  model: string;
  decision: TriageDecisionId;
}

/** Written when a person locks the record. */
export interface DoneRecordLock {
  /** SHA-256 over the record in RFC 8785 form, with `lock` left out. */
  digest: Sha256Digest;
  by: string;
  /** An RFC 3339 date-time. */
  at: string;
}

/** A done record: what done means for one work item. */
export interface DoneRecord {
  schema: typeof DONE_RECORD_SCHEMA;
  item: WorkItemId;
  lineage: string;
  /** Absent when a person wrote the record. */
  drafted_by?: DraftedBy;
  criteria: Criterion[];
  lock?: DoneRecordLock;
}

/** Where one criterion stands. */
export const CRITERION_STATES = ["open", "claimed", "held", "proven", "failed"] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];

/**
 * Where the whole record stands. A held record is done. Proven is the verifier's word.
 * WORK_VERDICTS in @oxagen/database repeats this list. Change both together.
 */
export const DONE_VERDICTS = ["pending", "held", "proven", "broken"] as const;
export type DoneVerdict = (typeof DONE_VERDICTS)[number];

/** Why a record is broken or pending. The codes are dod-spec.md's eight reasons. */
export const DONE_REASONS = {
  CHECK_FAILED: "A check in the locked set did not pass.",
  TOOL_DENIED: "The agent called a tool the set forbids.",
  BUDGET_EXCEEDED: "The work went over its cost, time, or tool-call budget.",
  ATTEMPTS_EXHAUSTED: "The agent tried to finish more times than the set allows.",
  LOCK_MISMATCH: "The done record does not match its lock digest.",
  EVIDENCE_INVALID: "The evidence did not validate, or its digests do not chain.",
  HUMAN_PENDING: "Every executable check passed, and a person's signature is outstanding.",
  HARNESS_ERROR: "The harness could not run a check. Oxagen never treats that as a pass.",
} as const;
export type DoneReasonCode = keyof typeof DONE_REASONS;
export const DONE_REASON_CODES = Object.keys(DONE_REASONS) as DoneReasonCode[];
