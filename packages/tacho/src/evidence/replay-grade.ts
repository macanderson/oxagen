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
 *
 * It also holds the one rule for what a recording owes a `view` reader, which
 * both seals, the Chain tab and the fork gate read (`frameOwesBody`,
 * `bodyIsPartial`):
 *
 * - A frame owes a body when its kind carries content
 *   (`isContentBearingFrame`) or when its producer chained a content digest.
 *   The write-ahead halves count, so a prompt dropped for size is a gap.
 * - A later sighting of a model call another frame already records owes
 *   nothing: the call's content is owed once, by the frame that sealed first.
 * - A body counts only when it holds everything its frame carried. A body the
 *   producer marked as missing a half is kept and served, and the frame still
 *   counts as missing its body.
 * - A producer with nothing to put in a body, such as a model call that was
 *   cancelled before it answered, writes an empty body (`null`) rather than
 *   none. An absent body therefore always means content was lost.
 */
import { LLM_CALL_DUPLICATE_OF_ATTR } from "../claude-code/llm-call-dedupe";

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
export const GRADE_ENFORCEMENT_TIERS = [
  "contained",
  "gateway",
  "harness",
  "observe",
] as const;
export type GradeEnforcementTier = (typeof GRADE_ENFORCEMENT_TIERS)[number];

export function isGradeEnforcementTier(
  value: unknown,
): value is GradeEnforcementTier {
  return (
    typeof value === "string" &&
    (GRADE_ENFORCEMENT_TIERS as readonly string[]).includes(value)
  );
}

/**
 * Frames whose bodies a `view` reader reads (spec §8.4: what the agent
 * asked, what the model returned, what a tool was called with and what came
 * back), by each recorder's type name: the ledger's `model.call_completed`
 * and `tool.call_completed`, the in-app assistant's
 * `model.engine_call_completed` and `tool.engine_call_completed`, a wrapped
 * session's `llm_call` and `tool_call`. Both seals derive `body_missing`
 * from this set, so a recording with no body on such a frame grades
 * `inspect` whether or not the producer chained a digest for it.
 *
 * The two `engine_call` names were missing until the bodies existed to read.
 * The in-app assistant is the only ledger producer in the tree and it has
 * always written those names, so this set matched none of its frames: an
 * assistant run derived no `body_missing` gap and could not have reached
 * `view` even once the bodies were captured. `@oxagen/run-ledger` derives
 * the same pair from its event registry (`stepKindOfEventType`); this module
 * is the leaf that registry's package depends on, so the names are spelled
 * here rather than imported, and `run-ledger`'s registry drift test holds
 * the two lists together.
 */
const CONTENT_BEARING_FRAME_TYPES: ReadonlySet<string> = new Set([
  "model.call_completed",
  "tool.call_completed",
  // The engine's own halves of the same two exchanges (ADR-043: the in-app
  // engine appends these). BOTH halves are listed, because the recorder puts
  // the request on the write-ahead frame and the result on the completion —
  // "the request, and so the turn's prompt, rides the write-ahead frame rather
  // than the completion" and "what the tool was called with, on the frame that
  // is durable before the tool runs" (assistant-run.ts). Spec §8.4 defines
  // `view` as what the agent asked AND what came back, so a recording that
  // dropped its prompt bodies and kept its completions is not `view`; listing
  // the completions alone would grade it so.
  "model.engine_call_started",
  "model.engine_call_completed",
  "tool.engine_call_started",
  "tool.engine_call_completed",
  "llm_call",
  "tool_call",
]);

export function isContentBearingFrame(type: string): boolean {
  return CONTENT_BEARING_FRAME_TYPES.has(type);
}

/**
 * The attrs the model proxy stamps on an `llm_call` whose body holds one half
 * of the exchange: the request or the response was past the size cap, or came
 * in an encoding the proxy could not decode (`collector/model-proxy.ts`). The
 * value says why (`too_large`, `not_decoded`).
 */
export const REQUEST_BODY_OMITTED_ATTR = "oxagen.request_body_omitted";
export const RESPONSE_BODY_OMITTED_ATTR = "oxagen.response_body_omitted";

/** What the completeness rule reads off one frame, from either recorder. */
export interface FrameBodyFacts {
  /** The ledger's event type, or a wrapped session's event kind. */
  type: string;
  /** The content digest the producer chained, or null when it chained none. */
  digest: string | null;
  /**
   * The frame is a later sighting of a model call that another frame already
   * records (`oxagen.llm_call_duplicate_of`, see `isLaterSighting`). The OTel
   * exporter's copy of a call the proxy sealed carries no bytes, and the
   * proxy's frame owes the body.
   */
  laterSighting?: boolean;
}

/**
 * Does this frame owe a `view` reader a body? A frame that owes one and has
 * no body retained is a `body_missing` gap. This is the whole rule; every
 * reader that derives the gap calls it.
 *
 * A frame that chained a digest owes its body even when it is a later
 * sighting, so a body a session retains always belongs to a frame this
 * counts. The session row's `body_frames <= content_frames` check relies on
 * that.
 */
export function frameOwesBody(frame: FrameBodyFacts): boolean {
  if (frame.digest !== null) return true;
  return isContentBearingFrame(frame.type) && frame.laterSighting !== true;
}

/** Is this wrapped frame a later sighting of a model call already sealed? */
export function isLaterSighting(
  attrs: Readonly<Record<string, string>> | undefined,
): boolean {
  return attrs?.[LLM_CALL_DUPLICATE_OF_ATTR] !== undefined;
}

/**
 * Does the body a wrapped frame kept hold only part of its content? Such a
 * body is still stored and served, and it does not count toward the
 * session's `body_frames`, so the session seals with `body_missing`.
 */
export function bodyIsPartial(
  attrs: Readonly<Record<string, string>> | undefined,
): boolean {
  return (
    attrs?.[REQUEST_BODY_OMITTED_ATTR] !== undefined ||
    attrs?.[RESPONSE_BODY_OMITTED_ATTR] !== undefined
  );
}

export interface ReplayGradeInput {
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

/** The grade alone; `explainReplayGrade` carries the ladder and its reasons. */
export function computeReplayGrade(input: ReplayGradeInput): ReplayGrade {
  return explainReplayGrade(input).grade;
}

/** One rung of the ladder: whether the recording reaches it, and why. */
export interface ReplayGradeRung {
  grade: ReplayGrade;
  met: boolean;
  /**
   * Why the rung is or is not met, as a stable machine-readable reason. A met
   * rung says what carries it; an unmet one names the single thing missing.
   */
  reason: string;
}

export interface ReplayGradeExplanation {
  grade: ReplayGrade;
  ladder: ReplayGradeRung[];
}

/**
 * The ladder, rung by rung, with the reason each is or is not reached — the
 * Chain-and-seal tab's `GRADE_LADDER` (Mission Control spec §8.4). The grade
 * is `computeReplayGrade`'s, so the panel and the gate can never disagree:
 * both read this one function.
 *
 * The rules per rung:
 *
 * - `inspect`: frames only. Any gap that hides what was said, or breaks the
 *   chain, stops here; so does a recording with no retained body, and an
 *   `observe`-tier run, whose frames were not enforced.
 * - `view`: every body present.
 * - `fork`: `view` plus every tool result body on a `gateway`-tier run, so a
 *   new model call can be made while tool results are served from the cassette.
 * - `retry`: `fork` plus a harness that reports a reproducible run.
 *
 * Unknown gap kinds are refused: a gap the vocabulary does not name cannot be
 * graded, and grading it as harmless would raise a grade the record does not
 * support.
 */
export function explainReplayGrade(
  input: ReplayGradeInput,
): ReplayGradeExplanation {
  const gaps = new Set(input.gaps);
  for (const gap of gaps) {
    if (!isCompletenessGapKind(gap)) {
      throw new RangeError(`unknown completeness gap kind: ${gap}`);
    }
  }

  // `inspect` is the floor: a recording that exists reaches it. Everything
  // above it is a reason to stop, evaluated in ladder order.
  const blocking = [...gaps].filter((gap) => INSPECT_ONLY_GAPS.has(gap)).sort();
  const viewBlock =
    blocking.length > 0
      ? blocking.join(",")
      : input.retainedBodies === 0
        ? "no_retained_bodies"
        : input.enforcementTier === "observe"
          ? "observe_tier"
          : null;
  const forkBlock =
    viewBlock !== null
      ? viewBlock
      : gaps.has("tool_bodies")
        ? "tool_bodies"
        : input.enforcementTier !== "gateway" &&
            input.enforcementTier !== "contained"
          ? `enforcement_tier:${input.enforcementTier}`
          : null;
  const retryBlock =
    forkBlock !== null
      ? forkBlock
      : input.harnessReproducible
        ? null
        : "harness_not_reproducible";

  const rung = (grade: ReplayGrade, block: string | null, met: string) => ({
    grade,
    met: block === null,
    reason: block ?? met,
  });
  const ladder: ReplayGradeRung[] = [
    rung("inspect", null, "frames_recorded"),
    rung("view", viewBlock, "bodies_retained"),
    rung("fork", forkBlock, "tool_cassette_complete"),
    rung("retry", retryBlock, "harness_reproducible"),
  ];
  // The grade is the highest rung reached; the ladder is monotone by
  // construction, so the last met rung is it.
  const grade = ladder.reduce<ReplayGrade>(
    (best, r) => (r.met ? r.grade : best),
    "inspect",
  );
  return { grade, ladder };
}

// ── The wrapped-session seal ─────────────────────────────────────────────────

export interface TachoSealInput {
  /** The gaps the host reported on `agent_stop`. */
  hostGaps: readonly string[];
  chainVerified: boolean;
  unobservedTail: boolean;
  telemetryGapCount: number;
  /** The workspace's retention mode at seal. */
  retentionMode: string;
  contentFrames: number;
  bodyFrames: number;
  /** Tool calls the session counted, and how many kept a result body. */
  toolCalls: number;
  toolBodyFrames: number;
  enforcementTier: string;
}

export interface TachoSeal {
  completenessGaps: string[];
  replayGrade: ReplayGrade;
}

/**
 * The seal for a wrapped session: the host's gaps plus what the control
 * plane observed. `tool_bodies` is derived from the session's own counters,
 * the same rule the ledger seal applies to its rows, so a host's self-report
 * can add the gap and never remove it. A gap kind outside the vocabulary is
 * kept on the record and grades `inspect`: a word nobody can grade cannot
 * raise a grade. `retry` needs a harness that reports a reproducible run; no
 * wrapped harness does, so `harnessReproducible` is false here.
 */
export function sealTachoSession(input: TachoSealInput): TachoSeal {
  const gaps = new Set<string>(input.hostGaps);
  if (!input.chainVerified) gaps.add("chain_break");
  if (input.unobservedTail) gaps.add("unobserved_tail");
  if (input.telemetryGapCount > 0) gaps.add("telemetry_gap");
  if (input.retentionMode === "digest_only") gaps.add("digest_only");
  else if (input.bodyFrames < input.contentFrames) gaps.add("body_missing");
  if (input.toolCalls > 0 && input.toolBodyFrames === 0)
    gaps.add("tool_bodies");
  const known: CompletenessGapKind[] = [];
  let unknown = false;
  for (const gap of gaps) {
    if (isCompletenessGapKind(gap)) known.push(gap);
    else unknown = true;
  }
  const tier =
    input.enforcementTier === "contained" ||
    input.enforcementTier === "gateway" ||
    input.enforcementTier === "harness"
      ? input.enforcementTier
      : "observe";
  return {
    completenessGaps: [...gaps],
    replayGrade: unknown
      ? "inspect"
      : computeReplayGrade({
          gaps: known,
          enforcementTier: tier,
          harnessReproducible: false,
          retainedBodies: input.bodyFrames,
        }),
  };
}
