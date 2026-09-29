// verify.ts: admit a verify stage's handoff only when the gateway's records
// show a contained run on a model no build stage used.
//
// agent-work-spec.html (The verify stage): "It must run on a contained runtime,
// where Oxagen writes the call log, and its model must differ from the model of
// every build stage in the work order. Oxagen checks both against what the
// gateway recorded, not against what the file says." So this check never reads
// the workflow file's `model` key or the agent file's runtime. It reads one
// record per session, and a session with no record fails the check: a record
// Oxagen cannot read proves nothing.

/** The tiers a session record carries, from tacho's session summary. */
export const SESSION_ENFORCEMENT_TIERS = ["contained", "gateway", "harness", "observe"] as const;
export type SessionEnforcementTier = (typeof SESSION_ENFORCEMENT_TIERS)[number];

/** What the gateway recorded about one session. */
export interface GatewaySession {
  sessionId: string;
  tier: SessionEnforcementTier;
  /** Every model the gateway routed a call to in the session. */
  models: string[];
}

/** The sessions the check reads. A null record means the gateway has none. */
export interface VerifyAdmissionInput {
  verifySessionId: string;
  verify: GatewaySession | null;
  /** Every build-kind run in the work order, including runs a return superseded. */
  builds: { role: string; sessionId: string; record: GatewaySession | null }[];
}

export const VERIFY_PROBLEM_CODES = [
  "verify_unrecorded",
  "not_contained",
  "no_model_recorded",
  "build_unrecorded",
  "shared_model",
] as const;
export type VerifyProblemCode = (typeof VERIFY_PROBLEM_CODES)[number];

export interface VerifyProblem {
  code: VerifyProblemCode;
  sessionId: string;
  message: string;
}

export type VerifyAdmission =
  | { admitted: true; verifyModels: string[]; buildModels: string[] }
  | { admitted: false; problems: VerifyProblem[] };

/** Check the verify session against the gateway's records. Fails closed. */
export function admitVerifyStage(input: VerifyAdmissionInput): VerifyAdmission {
  const problems: VerifyProblem[] = [];
  const { verify, verifySessionId } = input;

  if (verify === null) {
    problems.push({
      code: "verify_unrecorded",
      sessionId: verifySessionId,
      message: `The gateway holds no record of verify session ${verifySessionId}.`,
    });
  } else {
    if (verify.tier !== "contained") {
      problems.push({
        code: "not_contained",
        sessionId: verifySessionId,
        message: `Verify session ${verifySessionId} ran at the ${verify.tier} tier. A verify stage runs contained.`,
      });
    }
    if (verify.models.length === 0) {
      problems.push({
        code: "no_model_recorded",
        sessionId: verifySessionId,
        message: `The gateway recorded no model for verify session ${verifySessionId}.`,
      });
    }
  }

  const buildModels = new Set<string>();
  for (const build of input.builds) {
    if (build.record === null) {
      problems.push({
        code: "build_unrecorded",
        sessionId: build.sessionId,
        message: `The gateway holds no record of ${build.role} session ${build.sessionId}, so the verify model cannot be compared with it.`,
      });
      continue;
    }
    for (const model of build.record.models) buildModels.add(model);
  }

  const verifyModels = verify?.models ?? [];
  for (const model of verifyModels) {
    if (buildModels.has(model)) {
      problems.push({
        code: "shared_model",
        sessionId: verifySessionId,
        message: `Verify session ${verifySessionId} used ${model}, which a build stage also used. A verify stage runs on a model no build stage used.`,
      });
    }
  }

  if (problems.length > 0) return { admitted: false, problems };
  return { admitted: true, verifyModels: [...verifyModels], buildModels: [...buildModels].sort() };
}
