// criterion.ts: run one criterion's check, its oracle, and its negative.
//
// A negative is a case the criterion must reject. The done record names it in
// words, and the fixtures give it as parts of a trace that replace the real
// trace's parts. The negative runs against the criterion's mechanical check and
// against its oracle, and each must reject it. A check or an oracle that passes
// its negative cannot tell good work from bad, so the criterion is broken.
import { digestJcs, type Sha256Digest } from "@oxagen/run-evidence";
import type { SignatureEvidence } from "../decide";
import type { Criterion } from "../types";
import { evaluateCheck } from "./checks";
import { evaluateOracle } from "./oracles";
import type {
  CheckResult,
  CriterionFixtures,
  OracleResult,
  Trace,
} from "./types";

/**
 * What happened to a criterion's oracle.
 *
 * - `none`: the criterion names no oracle.
 * - `unbuilt`: the class has no evaluator, so the criterion stays held.
 * - `not-run`: the stage may not run oracles, so the criterion stays held.
 * - `ran`: the evaluator ran, and `oracle` holds its result.
 */
export type OracleStatus = "none" | "unbuilt" | "not-run" | "ran";

/**
 * What happened to a criterion's negative.
 *
 * - `none`: the criterion names no negative.
 * - `rejected`: every evaluator it ran against rejected it, as it must.
 * - `passed`: an evaluator passed it, so the criterion is broken.
 * - `error`: an evaluator could not decide it, so nothing passes.
 * - `missing`: the fixtures give no negative trace, so nothing passes.
 * - `unrunnable`: there is no mechanical check and no oracle that ran.
 */
export type NegativeStatus =
  | "none"
  | "rejected"
  | "passed"
  | "error"
  | "missing"
  | "unrunnable";

export interface NegativeResult {
  status: NegativeStatus;
  /** The digest of what the evaluators returned for the negative trace. */
  evidence?: Sha256Digest;
}

export interface CriterionResult {
  id: string;
  check?: CheckResult;
  oracle?: OracleResult;
  oracleStatus: OracleStatus;
  negative: NegativeResult;
}

export interface CriterionInput {
  criterion: Criterion;
  trace: Trace;
  fixtures?: CriterionFixtures;
  signature?: SignatureEvidence;
  /**
   * The trace the oracle reads, when it is not the check's. A check reads what
   * the build runtime captured. An oracle runs again in the contained verify
   * stage and reads what that runtime captured.
   */
  oracleTrace?: Trace;
  /** False when the stage may not run oracles, such as a stage that is not contained. */
  runOracle: boolean;
}

/** The trace with the negative's parts in place of its own. */
export function negativeTrace(trace: Trace, parts: Partial<Trace>): Trace {
  return { ...trace, ...parts };
}

type Outcome = "rejected" | "passed" | "error";

function outcomeOf(result: { ok: boolean; error?: true }): Outcome {
  if (result.ok) return "passed";
  return result.error ? "error" : "rejected";
}

function worst(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.includes("passed")) return "passed";
  if (outcomes.includes("error")) return "error";
  return "rejected";
}

/** Fold a negative's outcome into a check result. A failing check keeps its own reason. */
function foldCheck(
  positive: CheckResult,
  outcome: Outcome | "missing",
  negative: Sha256Digest | null,
): CheckResult {
  if (!positive.ok || outcome === "rejected") return positive;
  const evidence = digestJcs({ positive: positive.evidence, negative, outcome });
  if (outcome === "passed") return { ok: false, reason: "CHECK_FAILED", evidence };
  return { ok: false, error: true, reason: "HARNESS_ERROR", evidence };
}

/** Fold a negative's outcome into an oracle result. A failing oracle keeps its own reason. */
function foldOracle(
  positive: OracleResult,
  outcome: Outcome | "missing",
  negative: Sha256Digest | null,
): OracleResult {
  if (!positive.ok || outcome === "rejected") return positive;
  const evidence = digestJcs({ positive: positive.evidence, negative, outcome });
  if (outcome === "passed") return { ok: false, reason: "EVALUATOR_ERROR", evidence };
  if (outcome === "missing") {
    return { ok: false, error: true, reason: "FIXTURE_MISSING", evidence };
  }
  return { ok: false, error: true, reason: "EVALUATOR_ERROR", evidence };
}

/**
 * Evaluate one criterion against the trace. The check runs when the criterion
 * has one. The oracle runs when the stage allows it and the class has an
 * evaluator. The negative runs when the criterion names one.
 */
export function evaluateCriterion(input: CriterionInput): CriterionResult {
  const { criterion, trace, fixtures, signature, runOracle } = input;
  const verifyTrace = input.oracleTrace ?? trace;

  let check = criterion.check ? evaluateCheck(criterion.check, trace, signature) : undefined;

  let oracle: OracleResult | undefined;
  let oracleStatus: OracleStatus = "none";
  if (criterion.oracle) {
    if (!runOracle) {
      oracleStatus = "not-run";
    } else {
      oracle = evaluateOracle(criterion.oracle, fixtures?.oracle, verifyTrace);
      oracleStatus = oracle ? "ran" : "unbuilt";
    }
  }

  if (criterion.negative === undefined) {
    return result(criterion.id, check, oracle, oracleStatus, { status: "none" });
  }

  // A human check has nothing to run a trace against.
  const mechanical =
    criterion.check !== undefined && !("human" in criterion.check) ? criterion.check : undefined;
  if (!mechanical && !oracle) {
    return result(criterion.id, check, oracle, oracleStatus, { status: "unrunnable" });
  }

  const parts = fixtures?.negative;
  if (parts === undefined) {
    if (check && mechanical) check = foldCheck(check, "missing", null);
    if (oracle) oracle = foldOracle(oracle, "missing", null);
    return result(criterion.id, check, oracle, oracleStatus, { status: "missing" });
  }

  const outcomes: Outcome[] = [];
  let negCheck: CheckResult | undefined;
  let negOracle: OracleResult | undefined;
  if (check && mechanical) {
    negCheck = evaluateCheck(mechanical, negativeTrace(trace, parts), signature);
    const outcome = outcomeOf(negCheck);
    outcomes.push(outcome);
    check = foldCheck(check, outcome, negCheck.evidence);
  }
  if (oracle && criterion.oracle) {
    // evaluateOracle returned a result for the real trace, so it returns one here.
    const against = negativeTrace(verifyTrace, parts);
    negOracle = evaluateOracle(criterion.oracle, fixtures?.oracle, against) as OracleResult;
    const outcome = outcomeOf(negOracle);
    outcomes.push(outcome);
    oracle = foldOracle(oracle, outcome, negOracle.evidence);
  }
  const evidence = digestJcs({
    negative: criterion.negative,
    check: negCheck ? { ok: negCheck.ok, evidence: negCheck.evidence } : null,
    oracle: negOracle ? { ok: negOracle.ok, evidence: negOracle.evidence } : null,
  });
  return result(criterion.id, check, oracle, oracleStatus, {
    status: worst(outcomes),
    evidence,
  });
}

function result(
  id: string,
  check: CheckResult | undefined,
  oracle: OracleResult | undefined,
  oracleStatus: OracleStatus,
  negative: NegativeResult,
): CriterionResult {
  const out: CriterionResult = { id, oracleStatus, negative };
  if (check) out.check = check;
  if (oracle) out.oracle = oracle;
  return out;
}
