// runner.ts: the verify stage. It runs each criterion's check against what the
// build runtime captured, runs each oracle against what the contained verify
// runtime captured, runs every negative, and hands decide the evidence.
//
// agent-work-spec.html (The verify stage) sets the rules. The stage runs on a
// contained runtime, where Oxagen writes the call log, and its model differs
// from every build stage's model and from the drafting model. Both are read
// from what the gateway recorded, never from the work order file. When either
// fails, the stage runs no oracle, and a criterion can be held at best.
//
// Tool calls and usage come from the gateway's records for each build stage,
// never from a log the worker wrote. When a build stage's calls or usage were
// not observed by the gateway, the stage does not report usage to decide, and
// it runs no policy or budget oracle, because both would read counts the
// worker could have shaped.
import {
  type Criterion,
  type CriterionEvidence,
  type CriterionResult,
  type DoneEvidence,
  type DoneOutcome,
  type DoneReason,
  type DoneRecord,
  type DoneUsage,
  type Fixtures,
  type GatewayRecords,
  type SignatureEvidence,
  type Trace,
  type TraceFacts,
  deniedCalls,
  evaluateCheck,
  evaluateCriterion,
  mergeGatewayRecords,
} from "@oxagen/done-record";

/** One stage's model route and what the gateway recorded for it. */
export interface StageRecords {
  model: string;
  gateway: GatewayRecords;
}

export interface VerifyStageInput {
  record: DoneRecord;
  /** What the build runtime captured at the head of the work. Checks read it. */
  buildFacts: TraceFacts;
  /** What the contained verify runtime captured. Oracles read it. */
  verifyFacts: TraceFacts;
  /** The fixtures for each criterion, keyed by criterion id. */
  fixtures: Fixtures;
  /** Signatures on criteria a person decides, keyed by criterion id. */
  signatures?: Readonly<Record<string, SignatureEvidence>>;
  /** The agent that claimed each criterion, keyed by criterion id. */
  claims?: Readonly<Record<string, string>>;
  /** Every build stage of the work order, in order. */
  build: readonly StageRecords[];
  verify: StageRecords;
  /** The model route the gateway recorded for the drafting step, when a model drafted the record. */
  drafting?: string;
}

/**
 * Why the stage held something back.
 *
 * - `verify-not-contained`: the verify stage did not run contained. No oracle runs.
 * - `verify-not-gateway-observed`: the gateway did not observe the verify stage. No oracle runs.
 * - `verify-model-unrecorded`: the gateway recorded no model for the verify stage. No oracle runs.
 * - `verify-model-reused-build`: a build stage ran the verify model. No oracle runs.
 * - `verify-model-reused-drafting`: the verify model drafted the record. No oracle runs.
 * - `build-not-gateway-observed`: the gateway did not observe every build
 *   stage. No usage reaches decide, and no policy or budget oracle runs.
 */
export const VERIFY_REFUSALS = [
  "verify-not-contained",
  "verify-not-gateway-observed",
  "verify-model-unrecorded",
  "verify-model-reused-build",
  "verify-model-reused-drafting",
  "build-not-gateway-observed",
] as const;
export type VerifyRefusal = (typeof VERIFY_REFUSALS)[number];

export interface VerifyStageDeps {
  /** The done record's decide. The stage only gathers evidence for it. */
  decide: (evidence: DoneEvidence) => DoneOutcome;
}

export interface VerifyStageResult {
  outcome: DoneOutcome;
  /** What the stage handed decide. */
  evidence: DoneEvidence;
  /** Each criterion's check, oracle, and negative, in record order. */
  criteria: CriterionResult[];
  refusals: VerifyRefusal[];
  /** The criteria whose negative passed. Each is broken. */
  broken: string[];
}

/** The oracle classes that read the build stages' tool calls or usage. */
const READS_GATEWAY_COUNTS: ReadonlySet<string> = new Set(["policy", "budget"]);

/** The reasons the stage holds something back, from what the gateway recorded. */
export function verifyRefusals(
  input: Pick<VerifyStageInput, "record" | "build" | "verify" | "drafting">,
  buildGateway: GatewayRecords,
): VerifyRefusal[] {
  const refusals: VerifyRefusal[] = [];
  const { verify } = input;
  if (verify.gateway.tier !== "contained") refusals.push("verify-not-contained");
  if (verify.gateway.basis !== "gateway_observed") refusals.push("verify-not-gateway-observed");
  if (verify.model.length === 0) refusals.push("verify-model-unrecorded");
  if (input.build.some((stage) => stage.model === verify.model)) {
    refusals.push("verify-model-reused-build");
  }
  if (verify.model === input.drafting || verify.model === input.record.drafted_by?.model) {
    refusals.push("verify-model-reused-drafting");
  }
  if (buildGateway.basis !== "gateway_observed") refusals.push("build-not-gateway-observed");
  return refusals;
}

/** A person's signature decides the criterion: a human check, or no check and no oracle. */
function needsPerson(criterion: Criterion): boolean {
  if (criterion.check === undefined) return criterion.oracle === undefined;
  return "human" in criterion.check;
}

/** The check kinds whose result decide reads as check evidence. */
function carriesCheckEvidence(criterion: Criterion): boolean {
  const check = criterion.check;
  return check !== undefined && ("run" in check || "file" in check || "diff" in check);
}

function criterionEvidence(
  criterion: Criterion,
  result: CriterionResult,
  input: VerifyStageInput,
): CriterionEvidence {
  const out: CriterionEvidence = { id: criterion.id };
  const claimedBy = input.claims?.[criterion.id];
  if (claimedBy !== undefined) out.claimedBy = claimedBy;
  if (result.check && carriesCheckEvidence(criterion)) {
    const { ok, evidence, error } = result.check;
    out.check = error ? { ok, evidence, error } : { ok, evidence };
  }
  if (result.oracle) {
    // An oracle runs only in a contained verify stage, so its result is contained.
    const { ok, evidence, error } = result.oracle;
    const model = input.verify.model;
    out.oracle = error
      ? { ok, evidence, error, contained: true, model }
      : { ok, evidence, contained: true, model };
  }
  const signature = input.signatures?.[criterion.id];
  if (signature !== undefined && needsPerson(criterion)) out.signature = signature;
  return out;
}

/** The usage decide reads, or undefined when the gateway's count cannot be used. */
function usageOf(gateway: GatewayRecords, observed: boolean): DoneUsage | undefined {
  const { usd, toolCalls, minutes, stopAttempts } = gateway.usage;
  if (!observed || usd === null) return undefined;
  return { usd, toolCalls, minutes, stopAttempts };
}

/**
 * The failure a tools or budget check's negative caused. DoneEvidence carries
 * no result for these two kinds, only denials and usage, so decide cannot see
 * a negative that one of them passed or could not decide.
 */
function hiddenNegativeFailure(
  criterion: Criterion,
  result: CriterionResult,
  trace: Trace,
  signature: SignatureEvidence | undefined,
): DoneReason | undefined {
  const check = criterion.check;
  if (check === undefined || !("tools" in check || "budget" in check)) return undefined;
  if (result.check === undefined || result.check.ok) return undefined;
  // A check that fails on the real trace fails in decide too, from the denials or the usage.
  if (!evaluateCheck(check, trace, signature).ok) return undefined;
  return { code: result.check.reason ?? "HARNESS_ERROR", criterion: criterion.id };
}

/** Break the record for each failure decide could not see. */
function withHiddenFailures(outcome: DoneOutcome, failures: readonly DoneReason[]): DoneOutcome {
  if (failures.length === 0) return outcome;
  const failed = new Set(failures.map((failure) => failure.criterion));
  return {
    verdict: "broken",
    reasons: [...outcome.reasons, ...failures],
    criteria: outcome.criteria.map((entry) =>
      failed.has(entry.id) ? { id: entry.id, state: "failed" as const } : entry,
    ),
  };
}

/**
 * Run the verify stage over a done record and hand decide the evidence. The
 * stage is pure: every fact it reads was recorded by a runtime or the gateway
 * before it runs, and it reads no clock.
 */
export function runVerifyStage(input: VerifyStageInput, deps: VerifyStageDeps): VerifyStageResult {
  if (input.build.length === 0) {
    throw new TypeError("A verify stage needs at least one build stage to judge.");
  }
  const gateway = mergeGatewayRecords(input.build.map((stage) => stage.gateway));
  const trace: Trace = { ...input.buildFacts, gateway };
  const oracleTrace: Trace = { ...input.verifyFacts, gateway };
  const refusals = verifyRefusals(input, gateway);
  const stageMayRunOracles = !refusals.some((refusal) => refusal.startsWith("verify-"));
  const observed = !refusals.includes("build-not-gateway-observed");

  const criteria: CriterionResult[] = [];
  const evidence: CriterionEvidence[] = [];
  const hidden: DoneReason[] = [];
  const denials = new Set<string>();
  for (const criterion of input.record.criteria) {
    const oracleClass = criterion.oracle?.class;
    const readsCounts = oracleClass !== undefined && READS_GATEWAY_COUNTS.has(oracleClass);
    const signature = input.signatures?.[criterion.id];
    const result = evaluateCriterion({
      criterion,
      trace,
      oracleTrace,
      fixtures: input.fixtures[criterion.id],
      signature,
      runOracle: stageMayRunOracles && (observed || !readsCounts),
    });
    criteria.push(result);
    evidence.push(criterionEvidence(criterion, result, input));
    const failure = hiddenNegativeFailure(criterion, result, trace, signature);
    if (failure) hidden.push(failure);
    const check = criterion.check;
    if (check !== undefined && "tools" in check) {
      for (const call of deniedCalls(check.tools.deny, gateway.toolCalls)) denials.add(call.rule);
    }
  }

  const doneEvidence: DoneEvidence = {
    record: input.record,
    criteria: evidence,
    models: {
      build: input.build.map((stage) => stage.model),
      ...(input.drafting !== undefined ? { drafting: input.drafting } : {}),
    },
  };
  const usage = usageOf(gateway, observed);
  if (usage) doneEvidence.usage = usage;
  if (denials.size > 0) doneEvidence.denials = [...denials];

  const outcome = withHiddenFailures(deps.decide(doneEvidence), hidden);
  const broken = criteria
    .filter((result) => result.negative.status === "passed")
    .map((result) => result.id);
  return { outcome, evidence: doneEvidence, criteria, refusals, broken };
}
