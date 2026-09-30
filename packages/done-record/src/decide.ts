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
//
// Where the spec leaves a choice open, decide takes the stricter reading:
//
// - A criterion with neither a check nor an oracle is held by a person's
//   signature, so it counts as a human check and keeps the record from proven.
// - A record is proven only when at least one criterion is proven. With no
//   oracle run, there is no verifier's word.
// - A record drafted by a model is proven only when the gateway recorded the
//   drafting model and it differs from every build stage's model.
// - A proven oracle needs at least one recorded build model to differ from.
// - Evidence that names a criterion the record lacks, names one twice, or does
//   not fit the criterion is EVIDENCE_INVALID, and the record is broken.
// - A denial names the tools rule it broke. A denial that matches no tools
//   check in the record still breaks the record, with TOOL_DENIED.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { lockDigest } from "./lock-digest";
import { checkKind, isActor, isRfc3339, isSha256 } from "./patterns";
import {
  BUDGET_DEFAULT_STOP_ATTEMPTS,
  type CheckKind,
  type Criterion,
  type CriterionState,
  type DoneReasonCode,
  type DoneRecord,
  type DoneVerdict,
} from "./types";

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

/** The check kinds whose result arrives as CheckEvidence. */
const EVIDENCE_CHECK_KINDS: ReadonlySet<CheckKind> = new Set<CheckKind>(["run", "file", "diff"]);

/** Where one part of a criterion stands: its check, or its oracle. */
type PartState = "none" | "waiting" | "held" | "failed";
type OracleState = "none" | "waiting" | "passed" | "qualified" | "failed";

interface Judged {
  id: string;
  state: CriterionState;
  reasons: DoneReason[];
  /** True when a person's signature decides the criterion. */
  person: boolean;
  hasOracle: boolean;
  /** True when the criterion waits on a signature and nothing else. */
  awaitsSignature: boolean;
}

/** True when a person's signature decides the criterion: a human check, or no check and no oracle. */
function needsPerson(criterion: Criterion): boolean {
  if (criterion.check === undefined) return criterion.oracle === undefined;
  return checkKind(criterion.check) === "human";
}

function validUsage(usage: DoneUsage): boolean {
  return [usage.usd, usage.toolCalls, usage.minutes, usage.stopAttempts].every(
    (value) => Number.isFinite(value) && value >= 0,
  );
}

/** True when the evidence does not fit the criterion it names. */
function misfits(criterion: Criterion, evidence: CriterionEvidence): boolean {
  if (evidence.check !== undefined) {
    if (criterion.check === undefined) return true;
    if (!EVIDENCE_CHECK_KINDS.has(checkKind(criterion.check))) return true;
    if (!isSha256(evidence.check.evidence)) return true;
  }
  if (evidence.oracle !== undefined) {
    if (criterion.oracle === undefined) return true;
    if (!isSha256(evidence.oracle.evidence)) return true;
  }
  if (evidence.signature !== undefined) {
    if (!needsPerson(criterion)) return true;
    if (!isActor(evidence.signature.by) || !isRfc3339(evidence.signature.at)) return true;
  }
  return false;
}

function judgeCheck(
  criterion: Criterion,
  found: CriterionEvidence | undefined,
  evidence: DoneEvidence,
  reasons: DoneReason[],
): PartState {
  const id = criterion.id;
  const check = criterion.check;
  if (check === undefined) {
    if (criterion.oracle !== undefined) return "none";
    return found?.signature !== undefined ? "held" : "waiting";
  }
  if ("tools" in check) {
    const denied = (evidence.denials ?? []).some((rule) => check.tools.deny.includes(rule));
    if (!denied) return "held";
    reasons.push({ code: "TOOL_DENIED", criterion: id });
    return "failed";
  }
  if ("budget" in check) {
    const usage = evidence.usage;
    if (usage === undefined) return "waiting";
    if (!validUsage(usage)) {
      reasons.push({ code: "EVIDENCE_INVALID", criterion: id });
      return "failed";
    }
    const limits = check.budget;
    const over =
      (limits.usd !== undefined && usage.usd > limits.usd) ||
      (limits.tool_calls !== undefined && usage.toolCalls > limits.tool_calls) ||
      (limits.minutes !== undefined && usage.minutes > limits.minutes);
    const exhausted =
      usage.stopAttempts > (limits.stop_attempts ?? BUDGET_DEFAULT_STOP_ATTEMPTS);
    if (over) reasons.push({ code: "BUDGET_EXCEEDED", criterion: id });
    if (exhausted) reasons.push({ code: "ATTEMPTS_EXHAUSTED", criterion: id });
    return over || exhausted ? "failed" : "held";
  }
  if ("human" in check) {
    return found?.signature?.by === check.human ? "held" : "waiting";
  }
  const result = found?.check;
  if (result === undefined) return "waiting";
  if (result.error === true) {
    reasons.push({ code: "HARNESS_ERROR", criterion: id });
    return "failed";
  }
  if (!result.ok) {
    reasons.push({ code: "CHECK_FAILED", criterion: id });
    return "failed";
  }
  return "held";
}

/** True when the drafting model is known wherever the record says a model drafted it, and no build stage ran it. */
function draftingIndependent(evidence: DoneEvidence): boolean {
  const drafted = evidence.record.drafted_by?.model;
  const drafting = evidence.models.drafting;
  if (drafted !== undefined && drafting === undefined) return false;
  return [drafted, drafting].every(
    (model) => model === undefined || !evidence.models.build.includes(model),
  );
}

/** True when an oracle's pass came from a contained runtime and a model no build or drafting stage used. */
function qualifies(result: OracleEvidence, evidence: DoneEvidence): boolean {
  const model = result.model;
  const { build, drafting } = evidence.models;
  if (!result.contained || model.length === 0) return false;
  if (build.length === 0 || build.includes(model)) return false;
  if (model === drafting || model === evidence.record.drafted_by?.model) return false;
  return draftingIndependent(evidence);
}

function judgeOracle(
  criterion: Criterion,
  found: CriterionEvidence | undefined,
  evidence: DoneEvidence,
  reasons: DoneReason[],
): OracleState {
  if (criterion.oracle === undefined) return "none";
  const result = found?.oracle;
  if (result === undefined) return "waiting";
  if (result.error === true) {
    reasons.push({ code: "HARNESS_ERROR", criterion: criterion.id });
    return "failed";
  }
  if (!result.ok) {
    reasons.push({ code: "CHECK_FAILED", criterion: criterion.id });
    return "failed";
  }
  return qualifies(result, evidence) ? "qualified" : "passed";
}

function judge(
  criterion: Criterion,
  found: CriterionEvidence | undefined,
  evidence: DoneEvidence,
): Judged {
  const base = {
    id: criterion.id,
    person: needsPerson(criterion),
    hasOracle: criterion.oracle !== undefined,
  };
  if (found !== undefined && misfits(criterion, found)) {
    return {
      ...base,
      state: "failed",
      reasons: [{ code: "EVIDENCE_INVALID", criterion: criterion.id }],
      awaitsSignature: false,
    };
  }
  const reasons: DoneReason[] = [];
  const check = judgeCheck(criterion, found, evidence, reasons);
  const oracle = judgeOracle(criterion, found, evidence, reasons);
  if (check === "failed" || oracle === "failed") {
    return { ...base, state: "failed", reasons, awaitsSignature: false };
  }

  const untouched: CriterionState = found?.claimedBy ? "claimed" : "open";
  let state: CriterionState;
  if (check === "waiting") state = untouched;
  else if (oracle === "qualified") state = "proven";
  else if (check === "held") state = "held";
  else state = oracle === "passed" ? "held" : untouched;

  const waiting = state === "open" || state === "claimed";
  return {
    ...base,
    state,
    reasons,
    awaitsSignature: waiting && base.person && oracle !== "waiting",
  };
}

function dedupe(reasons: readonly DoneReason[]): DoneReason[] {
  const seen = new Set<string>();
  const out: DoneReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.code}\u0000${reason.criterion ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out;
}

/** Decide a done record's verdict. Pure. */
export function decide(evidence: DoneEvidence): DoneOutcome {
  const { record } = evidence;
  const reasons: DoneReason[] = [];

  if (record.lock === undefined || record.lock.digest !== lockDigest(record)) {
    reasons.push({ code: "LOCK_MISMATCH" });
  }

  const known = new Set(record.criteria.map((criterion) => criterion.id));
  const byId = new Map<string, CriterionEvidence>();
  const repeated = new Set<string>();
  for (const found of evidence.criteria) {
    if (!known.has(found.id)) {
      reasons.push({ code: "EVIDENCE_INVALID", criterion: found.id });
    } else if (byId.has(found.id)) {
      repeated.add(found.id);
    } else {
      byId.set(found.id, found);
    }
  }

  const rules = new Set(
    record.criteria.flatMap((criterion) =>
      criterion.check !== undefined && "tools" in criterion.check ? criterion.check.tools.deny : [],
    ),
  );
  if ((evidence.denials ?? []).some((rule) => !rules.has(rule))) {
    reasons.push({ code: "TOOL_DENIED" });
  }

  const judged = record.criteria.map((criterion): Judged => {
    if (!repeated.has(criterion.id)) return judge(criterion, byId.get(criterion.id), evidence);
    return {
      id: criterion.id,
      state: "failed",
      reasons: [{ code: "EVIDENCE_INVALID", criterion: criterion.id }],
      person: needsPerson(criterion),
      hasOracle: criterion.oracle !== undefined,
      awaitsSignature: false,
    };
  });
  const criteria = judged.map(({ id, state }) => ({ id, state }));

  const failures = dedupe([...reasons, ...judged.flatMap((entry) => entry.reasons)]);
  if (failures.length > 0) return { verdict: "broken", reasons: failures, criteria };

  const waiting = judged.filter((entry) => entry.state === "open" || entry.state === "claimed");
  if (waiting.length > 0) {
    const onlySignatures = waiting.every((entry) => entry.awaitsSignature);
    return {
      verdict: "pending",
      reasons: onlySignatures
        ? waiting.map((entry) => ({ code: "HUMAN_PENDING" as const, criterion: entry.id }))
        : [],
      criteria,
    };
  }

  const proven =
    judged.some((entry) => entry.state === "proven") &&
    judged.every((entry) => !entry.person && (entry.state === "proven" || !entry.hasOracle)) &&
    draftingIndependent(evidence);
  return { verdict: proven ? "proven" : "held", reasons: [], criteria };
}
