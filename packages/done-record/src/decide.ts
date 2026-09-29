// decide.ts: the verdict of one done record on the evidence gathered so far.
//
// decide is pure. Oxagen runs it again on every stage completion and every new
// signature, and the verdict follows the run: it never blocks an agent's stop.
// agent-work-spec.html (Done record) sets the rules:
//
// - pending: some criterion is open or claimed, or a signature is outstanding.
// - held: every criterion is held or proven. A held record is done.
// - proven: every criterion with an oracle is proven, the rest are held, and no
//   criterion has a human check.
// - broken: a criterion failed, or the record no longer matches its lock digest.
//
// A criterion is proven only when its oracle passed in a contained verify stage
// whose model differs from every build stage's model and from the drafting model.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { notBuilt } from "./not-built";
import type { CriterionState, DoneReasonCode, DoneRecord, DoneVerdict } from "./types";

/** What one run of a check or an oracle produced. */
export interface CheckEvidence {
  ok: boolean;
  /** The digest of the evidence envelope the run wrote. */
  evidence: Sha256Digest;
  /** True when the harness could not run the check. It never counts as a pass. */
  error?: true;
}

/** An oracle's run in the verify stage. */
export interface OracleEvidence extends CheckEvidence {
  /** True when the runtime was pinned and contained. */
  contained: boolean;
  /** The model route the gateway recorded for the verify stage. */
  model: string;
}

/** A person's signature on a human check. */
export interface SignatureEvidence {
  by: string;
  /** An RFC 3339 date-time. */
  at: string;
}

/** Everything gathered for one criterion. */
export interface CriterionEvidence {
  id: string;
  /** The agent that called claim_dod_item on the criterion, if one did. */
  claimedBy?: string;
  check?: CheckEvidence;
  oracle?: OracleEvidence;
  signature?: SignatureEvidence;
}

/** What the run spent against the record's budget check. */
export interface DoneUsage {
  usd: number;
  toolCalls: number;
  minutes: number;
  stopAttempts: number;
}

/** The input to decide. */
export interface DoneEvidence {
  record: DoneRecord;
  criteria: readonly CriterionEvidence[];
  /** The model routes the gateway recorded: the one that drafted the record, and every build stage's. */
  models: {
    drafting?: string;
    build: readonly string[];
  };
  usage?: DoneUsage;
  /** Tools the agent called that a tools check denies. */
  denials?: readonly string[];
}

/** One reason a record is broken or pending. */
export interface DoneReason {
  code: DoneReasonCode;
  /** The criterion the reason is about, when it is about one. */
  criterion?: string;
}

/** The output of decide. */
export interface DoneOutcome {
  verdict: DoneVerdict;
  reasons: DoneReason[];
  criteria: { id: string; state: CriterionState }[];
}

/** Decide a done record's verdict. Pure. */
export function decide(evidence: DoneEvidence): DoneOutcome {
  return notBuilt("decide", evidence);
}
