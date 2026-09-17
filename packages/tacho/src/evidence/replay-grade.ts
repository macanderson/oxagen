/**
 * The replay grade (Mission Control spec §8.4) and the completeness gaps it
 * is computed from (§13.1, tacho spec §2 "completeness.gaps[]").
 *
 * A grade is the strongest verb a person can apply to a recording. The
 * vocabulary is closed and ordered, weakest first, and every weaker verb comes
 * with a stronger grade. The grade is computed once, at seal, from the gaps
 * the recorder observed; nothing raises it afterwards, and an interface
 * renders the recorded word and never a stronger one.
 *
 * This module is pure so the ledger seal, the tacho seal and the handlers that
 * gate on a grade all run the same function.
 */

export const REPLAY_GRADES = ["inspect", "view", "fork", "retry"] as const;
export type ReplayGrade = (typeof REPLAY_GRADES)[number];

/**
 * Why a recording is weaker than the bytes could have made it. Each kind names
 * the thing that is missing.
 *
 * - `digest_only`: the workspace's retention policy kept digests, no bodies.
 * - `body_missing`: a frame carried content and its body was not retained.
 * - `tool_bodies`: no tool result body was retained (tacho vocabulary).
 * - `model_calls`: model calls went unobserved (OTel exporter absent).
 * - `hooks_partial`: a hook entry is missing for part of the session.
 * - `unobserved_tail`: the process ended without a terminal event.
 * - `chain_break`: the hash chain did not verify at some sequence.
 * - `telemetry_gap`: the producer reported dropped events.
 */
export const COMPLETENESS_GAP_KINDS = [
  "digest_only",
  "body_missing",
  "tool_bodies",
  "model_calls",
  "hooks_partial",
  "unobserved_tail",
  "chain_break",
  "telemetry_gap",
] as const;
export type CompletenessGapKind = (typeof COMPLETENESS_GAP_KINDS)[number];

/** The enforcement tiers the ladder distinguishes (spec §8.4). */
type GradeEnforcementTier = "gateway" | "harness" | "observe";

/**
 * Frames whose bodies a `view` reader reads (spec §8.4: what the agent
 * asked, what the model returned, what a tool was called with and what came
 * back), by each recorder's type name: the ledger's `model.call_completed`
 * and `tool.call_completed`, a wrapped session's `llm_call` and `tool_call`.
 * Both seals derive `body_missing` from this set, so a recording with no
 * body on such a frame grades `inspect` whether or not the producer chained
 * a digest for it.
 */
const CONTENT_BEARING_FRAME_TYPES: ReadonlySet<string> = new Set([
  "model.call_completed",
  "tool.call_completed",
  "llm_call",
  "tool_call",
]);

export function isContentBearingFrame(type: string): boolean {
  return CONTENT_BEARING_FRAME_TYPES.has(type);
}

interface ReplayGradeInput {
  /** The gaps the recorder observed, deduplicated by the caller or not. */
  gaps: readonly string[];
  /** Where the frames were observed from; `fork` needs the gateway. */
  enforcementTier: GradeEnforcementTier;
  /** Bodies the recorder retained. `view` needs at least one. */
  retainedBodies: number;
  /**
   * The harness reported that it can reproduce the run on a deterministic
   * ladder. Only a harness that says so earns `retry`; nothing infers it.
   */
  harnessReproducible: boolean;
}

/** Gaps that leave a reader with the chain and nothing it can read through. */
const INSPECT_ONLY_GAPS: ReadonlySet<string> = new Set<CompletenessGapKind>([
  "digest_only",
  "body_missing",
  "model_calls",
  "hooks_partial",
  "unobserved_tail",
  "chain_break",
  "telemetry_gap",
]);

export function isReplayGrade(value: unknown): value is ReplayGrade {
  return (
    typeof value === "string" &&
    (REPLAY_GRADES as readonly string[]).includes(value)
  );
}

export function isCompletenessGapKind(
  value: unknown,
): value is CompletenessGapKind {
  return (
    typeof value === "string" &&
    (COMPLETENESS_GAP_KINDS as readonly string[]).includes(value)
  );
}

/** Position in the ladder: `inspect` is 0, `retry` is 3. */
export function replayGradeRank(grade: ReplayGrade): number {
  return REPLAY_GRADES.indexOf(grade);
}

/** Does a recorded grade unlock `verb`? Every weaker verb comes with a grade. */
export function gradeAllows(
  recorded: ReplayGrade | null,
  verb: ReplayGrade,
): boolean {
  if (recorded === null) return false;
  return replayGradeRank(recorded) >= replayGradeRank(verb);
}

/**
 * The ladder, weakest rung first:
 *
 * - `inspect`: frames only. Any gap that hides what was said, or breaks the
 *   chain, stops here; so does a recording with no retained body, and an
 *   `observe`-tier run, whose frames were not enforced (spec §8.4).
 * - `view`: every body present. A missing tool result body stops here.
 * - `fork`: `view` plus tool result bodies on a `gateway`-tier run, so a new
 *   model call can be made while tool results are served from the cassette.
 * - `retry`: `fork` plus a harness that reports a reproducible run.
 *
 * Unknown gap kinds are refused: a gap the vocabulary does not name cannot be
 * graded, and grading it as harmless would raise a grade the record does not
 * support.
 */
export function computeReplayGrade(input: ReplayGradeInput): ReplayGrade {
  const gaps = new Set(input.gaps);
  for (const gap of gaps) {
    if (!isCompletenessGapKind(gap)) {
      throw new RangeError(`unknown completeness gap kind: ${gap}`);
    }
  }
  for (const gap of gaps) {
    if (INSPECT_ONLY_GAPS.has(gap)) return "inspect";
  }
  if (input.retainedBodies === 0) return "inspect";
  if (input.enforcementTier === "observe") return "inspect";
  if (gaps.has("tool_bodies")) return "view";
  if (input.enforcementTier !== "gateway") return "view";
  if (input.harnessReproducible) return "retry";
  return "fork";
}
