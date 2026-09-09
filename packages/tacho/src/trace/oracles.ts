/**
 * The replay oracles: pure functions over a parsed journal that hold a
 * harness's recording to the loop invariants. A TypeScript port of
 * `contextgraph-trace/src/oracle.rs`, check for check, evidence for evidence,
 * proven against the pinned upstream fixtures (`fixtures/contextgraph-trace`):
 * `golden*.ndjson` pass everything and each `trip-<check>.ndjson` fails
 * exactly that check.
 */
import { describeJournal, type Journal } from "./journal";
import {
  type CheckResult,
  fromViolations,
  skip,
  type TraceReport,
} from "./report";
import { type FrameId, isTraceTimestamp, type RenderedFrame } from "./types";

export const CHECK_SEQUENCE = "sequence-integrity";
export const CHECK_TURN_LOOP = "turn-loop-pairing";
export const CHECK_ASSEMBLY_BUDGET = "assembly-budget-honesty";
export const CHECK_STALENESS = "staleness-at-use";
export const CHECK_CITATION = "citation-at-use";
export const CHECK_COMPOSITION = "deterministic-composition";
export const CHECK_EFFECT_ONCE = "effect-exactly-once";
export const CHECK_RESUME = "resume-integrity";

export const ALL_CHECKS = [
  CHECK_SEQUENCE,
  CHECK_TURN_LOOP,
  CHECK_ASSEMBLY_BUDGET,
  CHECK_STALENESS,
  CHECK_CITATION,
  CHECK_COMPOSITION,
  CHECK_EFFECT_ONCE,
  CHECK_RESUME,
] as const;

export function runOracles(journal: Journal): TraceReport {
  return {
    target: describeJournal(journal),
    checks: [
      checkSequenceIntegrity(journal),
      checkTurnLoopPairing(journal),
      checkAssemblyBudgetHonesty(journal),
      checkStalenessAtUse(journal),
      checkCitationAtUse(journal),
      checkDeterministicComposition(journal),
      checkEffectExactlyOnce(journal),
      checkResumeIntegrity(journal),
    ],
  };
}

function frameLabel(frame: FrameId): string {
  return `${frame.provider_id}/${frame.frame_id}`;
}

function frameKey(frame: FrameId): string {
  return `${frame.provider_id}\u0001${frame.frame_id}\u0001${frame.content_digest ?? ""}`;
}

function frameSetKey(frames: RenderedFrame[]): string {
  return frames
    .map(
      (rendered) =>
        `${frameKey(rendered.frame)}\u0001${rendered.representation}`,
    )
    .join("\u0002");
}

function formatTurn(turn: number | undefined): string {
  return turn === undefined ? "None" : `Some(${turn})`;
}

export function checkSequenceIntegrity(journal: Journal): CheckResult {
  const violations: string[] = [];
  const events = journal.events;
  const first = events[0];
  if (!first) {
    return fromViolations(CHECK_SEQUENCE, ["journal contains no events"], "");
  }
  if (first.seq !== 1) {
    violations.push(`first event has seq ${first.seq}, not 1`);
  }
  if (first.event !== "session_start") {
    violations.push(
      `recording opens with \`${first.event}\`, not \`session_start\``,
    );
  }
  const session = first.session;
  let openTurn: number | undefined;
  let highestTurn = 0;
  let endedAt: number | undefined;

  events.forEach((event, index) => {
    if (index > 0) {
      const previous = events[index - 1]?.seq ?? 0;
      if (event.seq !== previous + 1) {
        violations.push(
          `seq ${event.seq} follows seq ${previous}: the sequence must be dense`,
        );
      }
      if (event.event === "session_start") {
        violations.push(`second \`session_start\` at seq ${event.seq}`);
      }
    }
    if (endedAt !== undefined) {
      violations.push(
        `\`${event.event}\` at seq ${event.seq} follows \`session_end\` at seq ${endedAt}`,
      );
    }
    if (event.session !== session) {
      violations.push(
        `seq ${event.seq} belongs to session '${event.session}' but the journal records '${session}'`,
      );
    }
    if (!isTraceTimestamp(event.at)) {
      violations.push(
        `seq ${event.seq} timestamp '${event.at}' is not an RFC 3339 UTC timestamp (F4 profile)`,
      );
    }
    switch (event.event) {
      case "turn_start": {
        if (event.turn === undefined) {
          violations.push(`\`turn_start\` at seq ${event.seq} names no turn`);
        } else if (openTurn !== undefined) {
          violations.push(
            `turn ${event.turn} started at seq ${event.seq} while turn ${openTurn} is still open`,
          );
        } else {
          if (event.turn <= highestTurn) {
            violations.push(
              `turn ${event.turn} started at seq ${event.seq} but turn numbers must strictly increase (highest so far: ${highestTurn})`,
            );
          }
          highestTurn = Math.max(highestTurn, event.turn);
          openTurn = event.turn;
        }
        break;
      }
      case "turn_end": {
        if (
          event.turn !== undefined &&
          openTurn !== undefined &&
          event.turn === openTurn
        ) {
          openTurn = undefined;
        } else {
          violations.push(
            `\`turn_end\` at seq ${event.seq} names turn ${formatTurn(event.turn)} but the open turn is ${formatTurn(openTurn)}`,
          );
        }
        break;
      }
      case "resume": {
        openTurn = undefined;
        if (event.turn !== undefined) {
          violations.push(
            `\`resume\` at seq ${event.seq} carries a turn: resumes are session-level`,
          );
        }
        break;
      }
      case "session_start":
      case "session_end": {
        if (event.turn !== undefined) {
          violations.push(
            `\`${event.event}\` at seq ${event.seq} carries a turn: session lifecycle events are session-level`,
          );
        }
        if (event.event === "session_end") {
          if (openTurn !== undefined && event.outcome === "completed") {
            violations.push(
              `session completed at seq ${event.seq} with turn ${openTurn} still open`,
            );
          }
          endedAt = event.seq;
        }
        break;
      }
      default: {
        if (event.turn !== openTurn) {
          violations.push(
            `\`${event.event}\` at seq ${event.seq} carries turn ${formatTurn(event.turn)} but the open turn is ${formatTurn(openTurn)}`,
          );
        }
      }
    }
  });

  const last = events[events.length - 1]?.seq ?? 0;
  return fromViolations(
    CHECK_SEQUENCE,
    violations,
    `${events.length} event(s), dense 1..=${last}, one session, timestamps well-formed, turn markers balanced`,
  );
}

export function checkTurnLoopPairing(journal: Journal): CheckResult {
  const violations: string[] = [];
  const pending = new Map<string, number>();
  const resolved = new Set<string>();
  const executed = new Set<string>();
  const everRequested = new Set<string>();
  let totalRequested = 0;

  for (const event of journal.events) {
    switch (event.event) {
      case "model_response": {
        for (const callId of event.tool_calls) {
          if (everRequested.has(callId)) {
            violations.push(
              `call id \`${callId}\` requested again at seq ${event.seq}: call ids are unique per session`,
            );
            continue;
          }
          everRequested.add(callId);
          totalRequested += 1;
          pending.set(callId, event.seq);
        }
        break;
      }
      case "tool_call": {
        if (executed.has(event.call_id)) {
          violations.push(
            `call \`${event.call_id}\` executed again at seq ${event.seq}: one execution per request`,
          );
        } else if (resolved.has(event.call_id)) {
          violations.push(
            `call \`${event.call_id}\` executed at seq ${event.seq} after it was already resolved`,
          );
        } else if (!pending.has(event.call_id)) {
          violations.push(
            `\`${event.tool}\` executed at seq ${event.seq} under call id \`${event.call_id}\` which the model never requested (phantom execution)`,
          );
        } else {
          executed.add(event.call_id);
        }
        break;
      }
      case "tool_result": {
        if (pending.delete(event.call_id)) {
          resolved.add(event.call_id);
        } else if (resolved.has(event.call_id)) {
          violations.push(
            `call \`${event.call_id}\` resolved again at seq ${event.seq}: exactly one result per call`,
          );
        } else {
          violations.push(
            `result at seq ${event.seq} for call \`${event.call_id}\` which was never requested (orphan result)`,
          );
        }
        break;
      }
      case "prompt_assembled": {
        if (pending.size > 0) {
          const dangling = [...pending.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([callId, at]) => `\`${callId}\` (requested at seq ${at})`);
          violations.push(
            `prompt assembled at seq ${event.seq} with ${dangling.length} unresolved tool call(s): ${dangling.join(", ")}`,
          );
          pending.clear();
        }
        break;
      }
      case "resume": {
        pending.clear();
        break;
      }
      case "session_end": {
        if (event.outcome === "completed" && pending.size > 0) {
          const dangling = [...pending.keys()].sort();
          violations.push(
            `session completed at seq ${event.seq} with unresolved tool call(s): ${dangling.join(", ")}`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  return fromViolations(
    CHECK_TURN_LOOP,
    violations,
    `${totalRequested} call(s) requested, each resolved exactly once before the next prompt`,
  );
}

export function checkAssemblyBudgetHonesty(journal: Journal): CheckResult {
  const violations: string[] = [];
  let prompts = 0;
  for (const event of journal.events) {
    if (event.event !== "prompt_assembled") {
      continue;
    }
    prompts += 1;
    const itemized = event.frames.reduce(
      (sum, frame) => sum + frame.token_cost,
      0,
    );
    if (itemized !== event.declared_total_tokens) {
      violations.push(
        `prompt at seq ${event.seq}: itemized frame costs sum to ${itemized} but the harness declared ${event.declared_total_tokens}: the arithmetic drifted from the itemization`,
      );
    }
    if (itemized > event.budget_tokens) {
      violations.push(
        `prompt at seq ${event.seq}: rendered frame costs sum to ${itemized} against the announced budget of ${event.budget_tokens} (B1 at assembly)`,
      );
    }
    for (const rendered of event.frames) {
      if (rendered.representation === "reference" && rendered.token_cost > 0) {
        violations.push(
          `prompt at seq ${event.seq}: reference frame ${frameLabel(rendered.frame)} declares token_cost ${rendered.token_cost}: a reference inlines nothing, so it costs 0`,
        );
      }
    }
  }
  return fromViolations(
    CHECK_ASSEMBLY_BUDGET,
    violations,
    `${prompts} prompt(s) assembled; itemized costs match declared totals and fit their budgets`,
  );
}

export function checkStalenessAtUse(journal: Journal): CheckResult {
  let observations = 0;
  let rendered = 0;
  const latest = new Map<
    string,
    { status: string; dead: boolean; seq: number }
  >();
  const violations: string[] = [];

  for (const event of journal.events) {
    if (event.event === "verify_observed") {
      observations += 1;
      const dead =
        event.verdict.status === "stale" || event.verdict.status === "gone";
      latest.set(frameKey(event.frame), {
        status: event.verdict.status,
        dead,
        seq: event.seq,
      });
    } else if (event.event === "prompt_assembled") {
      for (const { frame } of event.frames) {
        rendered += 1;
        const verdict = latest.get(frameKey(frame));
        if (verdict?.dead) {
          violations.push(
            `frame ${frameLabel(frame)} rendered at seq ${event.seq} was verified \`${verdict.status}\` at seq ${verdict.seq}: the host MUST NOT keep serving the body it holds (section 4 V2)`,
          );
        }
      }
    }
  }

  if (observations === 0) {
    return skip(
      CHECK_STALENESS,
      "no verify observations recorded: nothing to hold rendered frames against",
    );
  }
  return fromViolations(
    CHECK_STALENESS,
    violations,
    `${rendered} rendered frame(s) checked against ${observations} verify observation(s); none cited dead evidence`,
  );
}

export function checkCitationAtUse(journal: Journal): CheckResult {
  let rendered = 0;
  const violations: string[] = [];
  for (const event of journal.events) {
    if (event.event !== "prompt_assembled") {
      continue;
    }
    for (const frame of event.frames) {
      rendered += 1;
      const labelled = (frame.citation_label ?? "").trim() !== "";
      if (!labelled) {
        violations.push(
          `frame ${frameLabel(frame.frame)} rendered at seq ${event.seq} without a citation label (F3 at the point of use)`,
        );
      }
    }
  }
  return fromViolations(
    CHECK_CITATION,
    violations,
    `${rendered} rendered frame(s), every one carrying a citation label`,
  );
}

export function checkDeterministicComposition(journal: Journal): CheckResult {
  const compositions = new Map<string, { digest: string; seq: number }>();
  let digested = 0;
  const violations: string[] = [];
  for (const event of journal.events) {
    if (
      event.event !== "prompt_assembled" ||
      event.composition_digest === undefined
    ) {
      continue;
    }
    digested += 1;
    const key = frameSetKey(event.frames);
    const first = compositions.get(key);
    if (!first) {
      compositions.set(key, {
        digest: event.composition_digest,
        seq: event.seq,
      });
    } else if (first.digest !== event.composition_digest) {
      violations.push(
        `the frame set rendered at seq ${event.seq} is identical to seq ${first.seq} but composed to a different digest: an unchanged set must render byte-identically (section 1)`,
      );
    }
  }
  if (digested === 0) {
    return skip(
      CHECK_COMPOSITION,
      "no composition digests recorded: prefix stability not exercised by this journal",
    );
  }
  return fromViolations(
    CHECK_COMPOSITION,
    violations,
    `${digested} digest-carrying prompt(s); identical frame sets composed identically`,
  );
}

export function checkEffectExactlyOnce(journal: Journal): CheckResult {
  const firstPerformed = new Map<string, number>();
  const resumeSeqs: number[] = [];
  let effects = 0;
  const violations: string[] = [];
  for (const event of journal.events) {
    if (event.event === "resume") {
      resumeSeqs.push(event.seq);
      continue;
    }
    if (event.event !== "side_effect") {
      continue;
    }
    effects += 1;
    const first = firstPerformed.get(event.effect_id);
    if (first === undefined) {
      firstPerformed.set(event.effect_id, event.seq);
      continue;
    }
    const across = resumeSeqs.find((seq) => seq > first && seq < event.seq);
    const boundary =
      across === undefined
        ? ": duplicated within one live run"
        : `: replayed across the resume at seq ${across}`;
    violations.push(
      `effect \`${event.effect_id}\` (${event.kind}) first performed at seq ${first} was performed again at seq ${event.seq}${boundary}`,
    );
  }
  return fromViolations(
    CHECK_EFFECT_ONCE,
    violations,
    `${effects} side effect(s), every effect id performed exactly once`,
  );
}

export function checkResumeIntegrity(journal: Journal): CheckResult {
  let resumes = 0;
  const violations: string[] = [];
  journal.events.forEach((event, index) => {
    if (event.event !== "resume") {
      return;
    }
    resumes += 1;
    if (index === 0) {
      violations.push(
        `resume at seq ${event.seq} with no prior recorded events: there is nothing to resume`,
      );
      return;
    }
    const recordedThrough = journal.events[index - 1]?.seq ?? 0;
    if (event.last_seq_seen > recordedThrough) {
      violations.push(
        `resume at seq ${event.seq} claims to have recovered through seq ${event.last_seq_seen} but the journal records only through seq ${recordedThrough}: a recovery of events that never happened`,
      );
    } else if (event.last_seq_seen < recordedThrough) {
      violations.push(
        `resume at seq ${event.seq} recovered only through seq ${event.last_seq_seen} of ${recordedThrough} recorded: ${recordedThrough - event.last_seq_seen} recorded event(s) invisible to the resumed harness (quantified work loss)`,
      );
    }
  });
  if (resumes === 0) {
    return skip(
      CHECK_RESUME,
      "no resume recorded: durability not exercised by this journal",
    );
  }
  return fromViolations(
    CHECK_RESUME,
    violations,
    `${resumes} resume(s), each recovering exactly the recorded prefix`,
  );
}
